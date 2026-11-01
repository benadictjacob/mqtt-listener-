import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import nodemailer from 'nodemailer';

const dir = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set to at least 32 characters.');
  process.exit(1);
}
const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:5173';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/* ---------------------------------------------------------------- helpers */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cors = {
  'Access-Control-Allow-Origin': WEB_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function send(res, status, data) {
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) reject(new HttpError(413, 'Request body too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
  });
}

const query = (sql, args = []) => pool.query(sql, args).then((r) => r.rows);

async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn((sql, args = []) => client.query(sql, args).then((r) => r.rows));
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

function requireText(body, field, label = field, max = 120) {
  const value = typeof body[field] === 'string' ? body[field].trim() : '';
  if (!value) throw new HttpError(400, `${label} is required`);
  if (value.length > max) throw new HttpError(400, `${label} is too long`);
  return value;
}

function optionalText(body, field, max = 120) {
  const value = typeof body[field] === 'string' ? body[field].trim() : '';
  if (value.length > max) throw new HttpError(400, `${field} is too long`);
  return value || null;
}

function requireEmail(body) {
  const email = requireText(body, 'email', 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Email address is not valid');
  return email;
}

// 12 characters from a 54-symbol alphabet without look-alikes (0/O, 1/l/I),
// formatted XXXX-XXXX-XXXX so it can be read out over the phone.
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const chars = Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

function entityCode(prefix, name) {
  const stem = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || prefix;
  return `${prefix}-${stem}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

const isUniqueViolation = (e, constraint) => e.code === '23505' && (!constraint || e.constraint === constraint);

function publicProfile(u) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    role: u.role,
    vendor_id: u.vendor_id,
    customer_id: u.customer_id,
    must_change_password: u.must_change_password,
  };
}

/* Row-level scope for anything that hangs off a customer (alias `c`).
   Returns a SQL fragment and its arguments, numbered from `start`. */
function customerScope(user, start) {
  if (user.role === 'admin') return { sql: 'true', args: [] };
  if (user.role === 'vendor') return { sql: `c.vendor_id = $${start}`, args: [user.vendor_id] };
  return { sql: `c.id = $${start}`, args: [user.customer_id] };
}

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, 'You do not have access to this action');
}

/* ------------------------------------------------------- login throttling */

// Five failed attempts per email+address lock that pair out for 15 minutes.
const failedLogins = new Map();
const LOCKOUT_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function checkThrottle(key) {
  const entry = failedLogins.get(key);
  if (entry && entry.count >= MAX_FAILURES && Date.now() - entry.first < LOCKOUT_MS) {
    throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }
}

function recordFailure(key) {
  const entry = failedLogins.get(key);
  if (!entry || Date.now() - entry.first >= LOCKOUT_MS) failedLogins.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
}

/* ------------------------------------------------------------------ auth */

async function authenticate(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '');
  let claims;
  try {
    claims = jwt.verify(token, JWT_SECRET);
  } catch {
    throw new HttpError(401, 'Session expired or invalid');
  }
  const [user] = await query(
    'select id,email,full_name,role,vendor_id,customer_id,must_change_password,password_hash from app_users where id=$1',
    [claims.sub],
  );
  // Tokens are tied to the password hash, so changing the password signs out old sessions.
  if (!user || claims.pwd !== user.password_hash.slice(-12)) throw new HttpError(401, 'Session expired or invalid');
  return user;
}

const issueToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role, pwd: user.password_hash.slice(-12) }, JWT_SECRET, { expiresIn: '12h' });

async function login(req) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  // Behind the web proxy every socket is nginx; it passes the visitor in X-Real-IP.
  // Safe to trust because the API port is only published on 127.0.0.1.
  const key = `${email}|${req.headers['x-real-ip'] || req.socket.remoteAddress}`;
  checkThrottle(key);
  const [user] = await query('select * from app_users where email=$1', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    recordFailure(key);
    throw new HttpError(401, 'Invalid email or password');
  }
  failedLogins.delete(key);
  await query('update app_users set last_login_at=now() where id=$1', [user.id]);
  return { access_token: issueToken(user), profile: publicProfile(user) };
}

async function changePassword(req, user) {
  const body = await readBody(req);
  const current = String(body.current_password || '');
  const next = String(body.new_password || '');
  if (!(await bcrypt.compare(current, user.password_hash))) throw new HttpError(400, 'Current password is incorrect');
  if (next.length < 10) throw new HttpError(400, 'New password must be at least 10 characters');
  if (next === current) throw new HttpError(400, 'New password must be different from the current one');
  const hash = await bcrypt.hash(next, 12);
  const [updated] = await query(
    'update app_users set password_hash=$1, must_change_password=false where id=$2 returning *',
    [hash, user.id],
  );
  return { access_token: issueToken(updated), profile: publicProfile(updated) };
}

/* Creates the login for a new vendor or customer inside the caller's transaction. */
/* ------------------------------------------------------------------ mail */

// Optional: without SMTP_HOST the one-time password is only shown in the app.
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    })
  : null;

/* Returns whether the mail was accepted; a mail failure never undoes the account,
   because the admin still sees the password on screen. */
async function sendWelcomeEmail({ email, temporary_password, name, role }) {
  if (!mailer) return false;
  const appUrl = process.env.APP_URL || WEB_ORIGIN;
  try {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || 'Shade Energy BMS <no-reply@shade.local>',
      to: email,
      subject: 'Your Shade Energy BMS account',
      text: [
        `Hello ${name},`,
        '',
        `A ${role} account has been created for you on the Shade Energy BMS monitoring platform.`,
        '',
        `Sign in: ${appUrl}/login`,
        `Email: ${email}`,
        `Temporary password: ${temporary_password}`,
        '',
        'You will be asked to choose your own password when you first sign in.',
      ].join('\n'),
    });
    return true;
  } catch (e) {
    console.error(`Welcome email to ${email} failed: ${e.message}`);
    return false;
  }
}

async function createAccount(q, { email, fullName, role, vendorId = null, customerId = null, createdBy }) {
  const password = temporaryPassword();
  const hash = await bcrypt.hash(password, 12);
  try {
    await q(
      `insert into app_users(email,password_hash,full_name,role,vendor_id,customer_id,must_change_password,created_by)
       values($1,$2,$3,$4,$5,$6,true,$7)`,
      [email, hash, fullName, role, vendorId, customerId, createdBy],
    );
  } catch (e) {
    if (isUniqueViolation(e, 'app_users_email_key')) throw new HttpError(409, 'An account with this email already exists');
    throw e;
  }
  return { email, temporary_password: password };
}

/* --------------------------------------------------------------- vendors */

const VENDOR_COLUMNS = `v.id, v.name, v.code, v.status, v.contact_email, v.created_at,
  (select count(*)::int from customers c where c.vendor_id = v.id) as customer_count,
  (select count(*)::int from devices d join customers c on c.id = d.customer_id where c.vendor_id = v.id) as device_count`;

async function listVendors(user) {
  requireRole(user, 'admin');
  return query(`select ${VENDOR_COLUMNS} from vendors v order by v.created_at desc`);
}

async function getVendor(user, id) {
  requireRole(user, 'admin');
  const [vendor] = await query(`select ${VENDOR_COLUMNS} from vendors v where v.id=$1`, [id]);
  if (!vendor) throw new HttpError(404, 'Vendor not found');
  return vendor;
}

async function createVendor(req, user) {
  requireRole(user, 'admin');
  const body = await readBody(req);
  const name = requireText(body, 'name', 'Vendor name');
  const email = requireEmail(body);
  const result = await transaction(async (q) => {
    const [vendor] = await q(
      'insert into vendors(name,code,contact_email) values($1,$2,$3) returning id,name,code,status,contact_email,created_at',
      [name, entityCode('VEN', name), email],
    );
    const credentials = await createAccount(q, { email, fullName: name, role: 'vendor', vendorId: vendor.id, createdBy: user.id });
    return { vendor: { ...vendor, customer_count: 0, device_count: 0 }, credentials };
  });
  // Mail only after the commit, so a rolled-back account is never announced.
  result.credentials.email_sent = await sendWelcomeEmail({ ...result.credentials, name, role: 'vendor' });
  return result;
}

/* ------------------------------------------------------------- customers */

const CUSTOMER_COLUMNS = `c.id, c.vendor_id, c.name, c.code, c.status, c.contact_email, c.created_at,
  v.name as vendor_name, v.code as vendor_code,
  (select count(*)::int from devices d where d.customer_id = c.id) as device_count`;

async function listCustomers(user, params) {
  requireRole(user, 'admin', 'vendor');
  const scope = customerScope(user, 1);
  const args = [...scope.args];
  let sql = `select ${CUSTOMER_COLUMNS} from customers c join vendors v on v.id = c.vendor_id where ${scope.sql}`;
  if (params.get('vendor_id')) {
    args.push(params.get('vendor_id'));
    sql += ` and c.vendor_id = $${args.length}`;
  }
  return query(`${sql} order by c.created_at desc`, args);
}

async function getCustomer(user, id) {
  const scope = customerScope(user, 2);
  const [customer] = await query(
    `select ${CUSTOMER_COLUMNS} from customers c join vendors v on v.id = c.vendor_id where c.id=$1 and ${scope.sql}`,
    [id, ...scope.args],
  );
  if (!customer) throw new HttpError(404, 'Customer not found');
  return customer;
}

async function createCustomer(req, user) {
  requireRole(user, 'admin', 'vendor');
  const body = await readBody(req);
  const name = requireText(body, 'name', 'Customer name');
  const email = requireEmail(body);
  // Vendors always create under themselves; only an admin chooses the vendor.
  const vendorId = user.role === 'vendor' ? user.vendor_id : requireText(body, 'vendor_id', 'Vendor');
  const [vendor] = await query('select id,name,code from vendors where id=$1', [vendorId]);
  if (!vendor) throw new HttpError(400, 'Vendor not found');
  const result = await transaction(async (q) => {
    const [customer] = await q(
      `insert into customers(vendor_id,name,code,contact_email) values($1,$2,$3,$4)
       returning id,vendor_id,name,code,status,contact_email,created_at`,
      [vendorId, name, entityCode('CUST', name), email],
    );
    const credentials = await createAccount(q, {
      email,
      fullName: name,
      role: 'customer',
      vendorId,
      customerId: customer.id,
      createdBy: user.id,
    });
    return {
      customer: { ...customer, vendor_name: vendor.name, vendor_code: vendor.code, device_count: 0 },
      credentials,
    };
  });
  result.credentials.email_sent = await sendWelcomeEmail({ ...result.credentials, name, role: 'customer' });
  return result;
}

/* --------------------------------------------------------------- devices */

const DEVICE_COLUMNS = `d.id, d.customer_id, d.imei, d.imei as device_identifier, d.name, d.device_type,
  d.location, d.status, d.last_seen_at, d.created_at, c.name as customer_name, c.vendor_id`;

async function listDevices(user, params) {
  const scope = customerScope(user, 1);
  const args = [...scope.args];
  let sql = `select ${DEVICE_COLUMNS} from devices d join customers c on c.id = d.customer_id where ${scope.sql}`;
  if (params.get('customer_id')) {
    args.push(params.get('customer_id'));
    sql += ` and d.customer_id = $${args.length}`;
  }
  return query(`${sql} order by d.created_at desc`, args);
}

async function getDevice(user, id) {
  const scope = customerScope(user, 2);
  const [device] = await query(
    `select ${DEVICE_COLUMNS} from devices d join customers c on c.id = d.customer_id where d.id=$1 and ${scope.sql}`,
    [id, ...scope.args],
  );
  if (!device) throw new HttpError(404, 'Device not found');
  return device;
}

async function createDevice(req, user) {
  requireRole(user, 'admin', 'customer');
  const body = await readBody(req);
  const name = requireText(body, 'name', 'Device name');
  const imei = requireText(body, 'imei', 'IMEI', 20).replace(/\s/g, '');
  if (!/^\d{15}$/.test(imei)) throw new HttpError(400, 'IMEI must be exactly 15 digits');
  // Customers always register to themselves; only an admin chooses the customer.
  const customerId = user.role === 'customer' ? user.customer_id : requireText(body, 'customer_id', 'Customer');
  const [customer] = await query('select id,name,vendor_id from customers where id=$1', [customerId]);
  if (!customer) throw new HttpError(400, 'Customer not found');
  try {
    const [device] = await query(
      `insert into devices(customer_id,imei,name,device_type,location,created_by) values($1,$2,$3,$4,$5,$6)
       returning id,customer_id,imei,imei as device_identifier,name,device_type,location,status,last_seen_at,created_at`,
      [customerId, imei, name, optionalText(body, 'device_type'), optionalText(body, 'location'), user.id],
    );
    return { ...device, customer_name: customer.name, vendor_id: customer.vendor_id };
  } catch (e) {
    if (isUniqueViolation(e, 'devices_imei_key')) throw new HttpError(409, 'A device with this IMEI is already registered');
    throw e;
  }
}

async function latestTelemetry(user, id) {
  await getDevice(user, id);
  const [row] = await query('select * from device_current_data where device_id=$1', [id]);
  if (!row) throw new HttpError(404, 'No telemetry received yet');
  return row;
}

/* Most recent readings, oldest first, for charting. */
async function telemetryHistory(user, id, params) {
  await getDevice(user, id);
  const limit = Math.min(Math.max(parseInt(params.get('limit'), 10) || 120, 1), 1000);
  return query(
    `select * from (
       select received_at,
         (payload->'telemetry'->>'voltage')::float8 as voltage,
         (payload->'telemetry'->>'current')::float8 as current,
         (payload->'telemetry'->>'power')::float8 as power,
         (payload->'telemetry'->>'soc')::float8 as soc,
         (payload->'telemetry'->>'soh')::float8 as soh,
         (payload->'telemetry'->>'temperature')::float8 as temperature
       from telemetry_history where device_id=$1 order by received_at desc limit $2
     ) recent order by received_at`,
    [id, limit],
  );
}

/* --------------------------------------------------------------- overview */

// A device is online if it reported within this window. Matches the frontend's isOnline().
const ONLINE_WINDOW = "interval '5 minutes'";
// Readings that put an online device into "needs attention".
const HIGH_TEMPERATURE_C = 45;
const LOW_SOC_PCT = 15;

/* Dashboard figures for whatever the caller can see: the whole fleet for an
   admin, a vendor's customers, or a customer's own devices. */
async function overview(user) {
  const scope = customerScope(user, 1);
  const scoped = `select d.*, c.name as customer_name from devices d join customers c on c.id = d.customer_id where ${scope.sql}`;

  const [counts] = await query(
    `with scoped as (${scoped})
     select
       (select count(*)::int from customers c where ${scope.sql}) as customers,
       (select count(*)::int from scoped) as devices,
       (select count(*)::int from scoped where last_seen_at > now() - ${ONLINE_WINDOW}) as online,
       (select count(*)::int from scoped where last_seen_at is null) as never_reported,
       (select count(*)::int from scoped s join device_current_data cd on cd.device_id = s.id
         where s.last_seen_at > now() - ${ONLINE_WINDOW}
           and (cd.temperature >= ${HIGH_TEMPERATURE_C} or cd.soc <= ${LOW_SOC_PCT})) as attention,
       (select max(last_seen_at) from scoped) as last_ingest_at`,
    scope.args,
  );
  if (user.role === 'admin') {
    counts.vendors = (await query('select count(*)::int as n from vendors'))[0].n;
  }

  // Battery condition across devices that are reporting now; null when none are.
  const [fleet] = await query(
    `with scoped as (${scoped})
     select avg(cd.soc) as avg_soc, avg(cd.soh) as avg_soh, sum(cd.current) as total_current,
       max(cd.temperature) as max_temperature,
       (array_agg(s.name order by cd.temperature desc nulls last))[1] as warmest_device
     from scoped s join device_current_data cd on cd.device_id = s.id
     where s.last_seen_at > now() - ${ONLINE_WINDOW}`,
    scope.args,
  );

  // Share of registered devices that sent at least one message each day.
  const availability = await query(
    `with scoped as (${scoped}),
       days as (select generate_series(current_date - 13, current_date, interval '1 day')::date as day)
     select day,
       (select count(*)::int from scoped s where s.created_at::date <= day) as registered,
       (select count(distinct th.device_id)::int from telemetry_history th join scoped s on s.id = th.device_id
         where th.received_at >= day and th.received_at < day + 1) as reported
     from days order by day`,
    scope.args,
  );

  const accountScope =
    user.role === 'admin' ? 'true' : user.role === 'vendor' ? 'au.vendor_id = $1' : 'au.customer_id = $1';
  const accounts = await query(
    `select au.role as kind, au.full_name as name, au.created_at as at, cu.full_name as actor
     from app_users au left join app_users cu on cu.id = au.created_by
     where au.role <> 'admin' and ${accountScope} order by au.created_at desc limit 10`,
    scope.args,
  );
  const registrations = await query(
    `with scoped as (${scoped})
     select 'device' as kind, s.name, s.created_at as at, cu.full_name as actor, s.customer_name, s.imei
     from scoped s left join app_users cu on cu.id = s.created_by order by s.created_at desc limit 10`,
    scope.args,
  );
  const activity = [...accounts, ...registrations]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 8);

  const alertRows = await query(
    `with scoped as (${scoped})
     select s.name, s.imei, s.customer_name, s.location, s.last_seen_at, s.created_at,
       cd.temperature, cd.soc,
       s.last_seen_at > now() - ${ONLINE_WINDOW} as online
     from scoped s left join device_current_data cd on cd.device_id = s.id`,
    scope.args,
  );
  const alerts = [];
  for (const d of alertRows) {
    const source = [d.customer_name, d.location].filter(Boolean).join(' · ');
    if (!d.last_seen_at) {
      alerts.push({ type: 'info', message: `${d.name} has not reported yet`, at: d.created_at, source, code: d.imei,
        detail: 'Registered but no MQTT message with this IMEI has arrived. Check the LTE module is powered and configured with this broker.' });
    } else if (!d.online) {
      alerts.push({ type: 'fault', message: `${d.name} stopped reporting`, at: d.last_seen_at, source, code: d.imei,
        detail: 'No telemetry for more than 5 minutes.' });
    } else {
      if (d.temperature >= HIGH_TEMPERATURE_C) {
        alerts.push({ type: 'warning', message: `${d.name} temperature ${d.temperature.toFixed(1)} °C`, at: d.last_seen_at, source, code: d.imei,
          detail: `At or above the ${HIGH_TEMPERATURE_C} °C attention threshold.` });
      }
      if (d.soc <= LOW_SOC_PCT) {
        alerts.push({ type: 'warning', message: `${d.name} state of charge ${d.soc.toFixed(1)} %`, at: d.last_seen_at, source, code: d.imei,
          detail: `At or below the ${LOW_SOC_PCT} % attention threshold.` });
      }
    }
  }
  const severity = { fault: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severity[a.type] - severity[b.type] || new Date(b.at) - new Date(a.at));

  return { counts, fleet, availability, activity, alerts: alerts.slice(0, 10) };
}

/* ---------------------------------------------------------------- router */

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true });
  if (m === 'POST' && p === '/api/auth/login') return send(res, 200, await login(req));

  const user = await authenticate(req);
  if (m === 'GET' && p === '/api/auth/me') return send(res, 200, publicProfile(user));
  if (m === 'POST' && p === '/api/auth/change-password') return send(res, 200, await changePassword(req, user));
  // A temporary password only unlocks the change-password step.
  if (user.must_change_password) throw new HttpError(403, 'Change your temporary password to continue');

  let match;
  if (m === 'GET' && p === '/api/overview') return send(res, 200, await overview(user));
  if (p === '/api/vendors') {
    if (m === 'GET') return send(res, 200, await listVendors(user));
    if (m === 'POST') return send(res, 201, await createVendor(req, user));
  }
  if (m === 'GET' && (match = p.match(/^\/api\/vendors\/([^/]+)$/))) {
    return send(res, 200, await getVendor(user, decodeURIComponent(match[1])));
  }
  if (p === '/api/customers') {
    if (m === 'GET') return send(res, 200, await listCustomers(user, url.searchParams));
    if (m === 'POST') return send(res, 201, await createCustomer(req, user));
  }
  if (m === 'GET' && (match = p.match(/^\/api\/customers\/([^/]+)$/))) {
    return send(res, 200, await getCustomer(user, decodeURIComponent(match[1])));
  }
  if (p === '/api/devices') {
    if (m === 'GET') return send(res, 200, await listDevices(user, url.searchParams));
    if (m === 'POST') return send(res, 201, await createDevice(req, user));
  }
  if (m === 'GET' && (match = p.match(/^\/api\/devices\/([^/]+)\/telemetry\/latest$/))) {
    return send(res, 200, await latestTelemetry(user, decodeURIComponent(match[1])));
  }
  if (m === 'GET' && (match = p.match(/^\/api\/devices\/([^/]+)\/telemetry\/history$/))) {
    return send(res, 200, await telemetryHistory(user, decodeURIComponent(match[1]), url.searchParams));
  }
  if (m === 'GET' && (match = p.match(/^\/api\/devices\/([^/]+)$/))) {
    return send(res, 200, await getDevice(user, decodeURIComponent(match[1])));
  }
  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  try {
    await route(req, res);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

/* ------------------------------------------------------------------ boot */

// The first admin comes from the environment; later accounts are created in the app.
async function bootstrapAdmin() {
  const [{ count }] = await query("select count(*)::int as count from app_users where role='admin'");
  if (count > 0) return;
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!email || password.length < 10) {
    console.error('No admin exists. Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) to create the first one.');
    process.exit(1);
  }
  await query(
    `insert into app_users(email,password_hash,full_name,role,must_change_password) values($1,$2,'Administrator','admin',true)`,
    [email, await bcrypt.hash(password, 12)],
  );
  console.log(`Created initial admin ${email}; the password must be changed at first sign-in.`);
}

await pool.query(fs.readFileSync(path.join(dir, 'init.sql'), 'utf8'));
await bootstrapAdmin();
server.listen(8000, '0.0.0.0', () => console.log('BMS API listening on :8000'));
