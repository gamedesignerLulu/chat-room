// Signal Room — chat server
// Express + Socket.IO, all state persisted to data.json

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');
const { v4: uuid } = require('uuid');

const DATA_FILE = path.join(__dirname, 'data.json');
const JWT_SECRET = process.env.JWT_SECRET || 'signal-room-dev-secret-change-me';
const PORT = process.env.PORT || 3000;
const EFFECT_TYPES = ['disco', 'confetti', 'snow', 'blackout'];

// ---------- rank hierarchy ----------
// Higher number = more power. Used everywhere to decide who can act on whom.
const RANKS = { user: 0, mod: 1, admin: 2, dev: 3, owner: 4 };
const ALL_STAFF_RANKS = ['mod', 'admin', 'dev', 'owner'];
function rankLevel(u) { return RANKS[(u && u.role) || 'user'] ?? 0; }
function isStaff(u) { return rankLevel(u) >= RANKS.mod; }
function isAdminPlus(u) { return rankLevel(u) >= RANKS.admin; }
function isDevPlus(u) { return rankLevel(u) >= RANKS.dev; }
function isOwner(u) { return rankLevel(u) >= RANKS.owner; }
// Can `actor` take a moderation action (warn/mute/ban/pin/delete/etc.) against `target`?
function canModerate(actor, target) {
  if (!actor || !target) return false;
  if (actor.id === target.id) return false;
  return rankLevel(actor) > rankLevel(target);
}
// What's the highest role `actor` is allowed to assign to someone?
function maxAssignableRole(actor) {
  const lvl = rankLevel(actor);
  if (lvl >= RANKS.owner) return 'owner';
  if (lvl >= RANKS.dev) return 'admin';
  if (lvl >= RANKS.admin) return 'mod';
  return null;
}

// ---------- data.json persistence ----------
let writeQueue = Promise.resolve();
function loadData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const data = JSON.parse(raw);
  // Backfill fields for older data.json files so upgrades don't crash.
  data.reports = data.reports || [];
  data.channels = data.channels || [{ id: 'general', name: 'general', topic: '', createdAt: new Date().toISOString(), createdBy: 'system' }];
  data.users.forEach(u => {
    if (u.avatarUrl === undefined) u.avatarUrl = null;
    if (u.nickname === undefined) u.nickname = null;
    if (u.staffTitle === undefined) u.staffTitle = null;
    if (!(u.role in RANKS)) u.role = 'user';
  });
  data.messages.forEach(m => {
    if (m.pinned === undefined) m.pinned = false;
    if (m.channelId === undefined) m.channelId = 'general';
  });
  return data;
}
function saveData(data) {
  writeQueue = writeQueue.then(() => fs.promises.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'));
  return writeQueue;
}

let db = loadData();
const serverStartedAt = Date.now();

// ---------- helpers ----------
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown';
}
function getSocketIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return socket.handshake.address?.replace('::ffff:', '') || 'unknown';
}
function isIpBanned(ip) {
  return db.bans.some(b => b.ip === ip && !b.liftedAt);
}
function findUser(id) {
  return db.users.find(u => u.id === id);
}
function findChannel(id) {
  return db.channels.find(c => c.id === id);
}
function displayName(u) {
  return (u.nickname && u.nickname.trim()) ? u.nickname.trim() : u.username;
}
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname || null,
    displayName: displayName(u),
    role: u.role,
    rankLevel: rankLevel(u),
    staffTitle: u.staffTitle || null,
    avatarColor: u.avatarColor,
    avatarUrl: u.avatarUrl || null,
    banned: u.banned,
    muted: u.muted,
    muteExpires: u.muteExpires,
    createdAt: u.createdAt
  };
}
function signToken(u) {
  return jwt.sign({ id: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
}
function randomColor() {
  const palette = ['#5EEAD4', '#F5A623', '#7C9CFF', '#F5738C', '#8CE99A', '#D6A2E8'];
  return palette[Math.floor(Math.random() * palette.length)];
}

// ---------- express setup ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  const ip = getClientIp(req);
  if (isIpBanned(ip) && !req.path.startsWith('/api/ban-status')) {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'banned', message: 'Your IP address is banned from this server.' });
    }
  }
  next();
});

const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${uuid()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype);
    cb(ok ? null : new Error('Only image/gif files are allowed'), ok);
  }
});
const avatarUpload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp)$/.test(file.mimetype);
    cb(ok ? null : new Error('Profile pictures must be png, jpg, or webp'), ok);
  }
});

// ---------- auth middleware ----------
function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUser(payload.id);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    if (user.banned) return res.status(403).json({ error: 'Account is banned' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
function rankRequired(minRole) {
  const minLevel = RANKS[minRole];
  return (req, res, next) => {
    if (rankLevel(req.user) < minLevel) {
      return res.status(403).json({ error: `Requires ${minRole} rank or higher.` });
    }
    next();
  };
}
const staffRequired = rankRequired('mod');
const adminRequired = rankRequired('admin');
const devRequired = rankRequired('dev');
const ownerRequired = rankRequired('owner');

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/register', async (req, res) => {
  const ip = getClientIp(req);
  if (isIpBanned(ip)) return res.status(403).json({ error: 'Your IP address is banned from this server.' });

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore.' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuid(), username, passwordHash, role: 'user',
    avatarColor: randomColor(), avatarUrl: null, nickname: null, staffTitle: null,
    createdAt: new Date().toISOString(), banned: false, muted: false, muteExpires: null, lastIp: ip
  };
  db.users.push(user);
  await saveData(db);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const ip = getClientIp(req);
  if (isIpBanned(ip)) return res.status(403).json({ error: 'Your IP address is banned from this server.' });

  const { username, password } = req.body || {};
  const user = db.users.find(u => u.username.toLowerCase() === (username || '').toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });
  if (user.banned) return res.status(403).json({ error: 'This account has been banned.' });

  user.lastIp = ip;
  await saveData(db);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', authRequired, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/ban-status', (req, res) => {
  res.json({ banned: isIpBanned(getClientIp(req)) });
});

// ============================================================
// PROFILE (settings tab: nickname + profile picture)
// ============================================================
app.post('/api/me/nickname', authRequired, async (req, res) => {
  let { nickname } = req.body || {};
  nickname = (nickname || '').toString().trim();
  if (nickname.length > 24) return res.status(400).json({ error: 'Nickname must be 24 characters or fewer.' });
  const user = findUser(req.user.id);
  user.nickname = nickname || null;
  await saveData(db);
  req.app.get('io').emit('user:updated', publicUser(user));
  res.json({ user: publicUser(user) });
});

app.post('/api/me/avatar', authRequired, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image provided.' });
    const user = findUser(req.user.id);
    user.avatarUrl = `/uploads/${req.file.filename}`;
    await saveData(db);
    req.app.get('io').emit('user:updated', publicUser(user));
    res.json({ user: publicUser(user) });
  });
});

app.delete('/api/me/avatar', authRequired, async (req, res) => {
  const user = findUser(req.user.id);
  user.avatarUrl = null;
  await saveData(db);
  req.app.get('io').emit('user:updated', publicUser(user));
  res.json({ user: publicUser(user) });
});

app.get('/api/team', (req, res) => {
  const team = db.users.filter(u => isStaff(u)).map(publicUser)
    .sort((a, b) => b.rankLevel - a.rankLevel);
  res.json({ team });
});

// ============================================================
// CHANNELS
// ============================================================
app.get('/api/channels', authRequired, (req, res) => {
  res.json({ channels: db.channels });
});

app.post('/api/staff/channels', authRequired, adminRequired, async (req, res) => {
  let { name, topic } = req.body || {};
  name = (name || '').toString().trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
  if (!name) return res.status(400).json({ error: 'A valid channel name is required.' });
  if (db.channels.some(c => c.id === name)) return res.status(409).json({ error: 'A channel with that name already exists.' });
  const channel = { id: name, name, topic: (topic || '').toString().slice(0, 140), createdAt: new Date().toISOString(), createdBy: req.user.username };
  db.channels.push(channel);
  await saveData(db);
  req.app.get('io').emit('channels:updated', db.channels);
  res.json({ channel });
});

app.delete('/api/staff/channels/:id', authRequired, adminRequired, async (req, res) => {
  if (db.channels.length <= 1) return res.status(400).json({ error: "Can't delete the only remaining channel." });
  const channel = findChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  db.channels = db.channels.filter(c => c.id !== channel.id);
  db.messages = db.messages.filter(m => m.channelId !== channel.id);
  await saveData(db);
  req.app.get('io').emit('channels:updated', db.channels);
  req.app.get('io').emit('channel:deleted', { id: channel.id });
  res.json({ ok: true });
});

// ============================================================
// CHAT HISTORY / SETTINGS / PINNED
// ============================================================
app.get('/api/messages', authRequired, (req, res) => {
  const channelId = req.query.channelId || 'general';
  res.json({ messages: db.messages.filter(m => m.channelId === channelId).slice(-200) });
});

app.get('/api/pinned', authRequired, (req, res) => {
  const channelId = req.query.channelId || 'general';
  res.json({ pinned: db.messages.filter(m => m.pinned && !m.deleted && m.channelId === channelId) });
});

app.get('/api/settings', (req, res) => res.json({ settings: db.settings }));
app.get('/api/events', (req, res) => res.json({ events: db.events }));

// ============================================================
// REPORTS
// ============================================================
app.post('/api/reports', authRequired, async (req, res) => {
  const { messageId, reason, confirmed } = req.body || {};
  if (!confirmed) return res.status(400).json({ error: 'You must confirm the report before submitting.' });
  const msg = db.messages.find(m => m.id === messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  if (msg.userId === req.user.id) return res.status(400).json({ error: "You can't report your own message." });

  const report = {
    id: uuid(), messageId: msg.id, messageSnippet: (msg.content || '').slice(0, 200), messageType: msg.type,
    channelId: msg.channelId, reportedUserId: msg.userId, reportedUsername: msg.username,
    reporterId: req.user.id, reporterUsername: req.user.username,
    reason: (reason || 'No reason given').toString().slice(0, 500),
    timestamp: new Date().toISOString(), resolved: false, resolvedBy: null, resolvedAt: null
  };
  db.reports.push(report);
  await saveData(db);
  req.app.get('io').to('staff-room').emit('staff:report', report);
  res.json({ ok: true });
});

// ============================================================
// STAFF ROUTES — moderation (mod+)
// ============================================================
app.get('/api/staff/users', authRequired, staffRequired, (req, res) => {
  res.json({ users: db.users.map(publicUser), myRank: rankLevel(req.user), maxAssignable: maxAssignableRole(req.user) });
});
app.get('/api/staff/bans', authRequired, staffRequired, (req, res) => res.json({ bans: db.bans }));
app.get('/api/staff/warnings', authRequired, staffRequired, (req, res) => res.json({ warnings: db.warnings }));
app.get('/api/staff/reports', authRequired, staffRequired, (req, res) => res.json({ reports: db.reports.slice().reverse() }));

app.post('/api/staff/reports/:id/resolve', authRequired, staffRequired, async (req, res) => {
  const report = db.reports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  report.resolved = true;
  report.resolvedBy = req.user.username;
  report.resolvedAt = new Date().toISOString();
  await saveData(db);
  req.app.get('io').to('staff-room').emit('staff:report-resolved', { id: report.id });
  res.json({ report });
});

app.post('/api/staff/warn', authRequired, staffRequired, async (req, res) => {
  const { userId, reason } = req.body || {};
  const target = findUser(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!canModerate(req.user, target)) return res.status(403).json({ error: "You can't moderate someone of equal or higher rank." });
  const warning = { id: uuid(), userId: target.id, username: target.username, reason: reason || 'No reason given', warnedBy: req.user.username, timestamp: new Date().toISOString() };
  db.warnings.push(warning);
  await saveData(db);
  req.app.get('io').to(`user:${target.id}`).emit('moderation:warned', warning);
  req.app.get('io').emit('staff:log', { type: 'warn', actor: req.user.username, target: target.username, reason: warning.reason, at: warning.timestamp });
  res.json({ warning });
});

app.post('/api/staff/mute', authRequired, staffRequired, async (req, res) => {
  const { userId, minutes, reason } = req.body || {};
  const target = findUser(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!canModerate(req.user, target)) return res.status(403).json({ error: "You can't moderate someone of equal or higher rank." });
  target.muted = true;
  target.muteExpires = minutes ? new Date(Date.now() + minutes * 60000).toISOString() : null;
  await saveData(db);
  const io_ = req.app.get('io');
  io_.to(`user:${target.id}`).emit('moderation:muted', { minutes: minutes || null, reason: reason || null, muteExpires: target.muteExpires });
  io_.emit('user:updated', publicUser(target));
  io_.emit('staff:log', { type: 'mute', actor: req.user.username, target: target.username, reason: reason || '', at: new Date().toISOString() });
  res.json({ user: publicUser(target) });
});

app.post('/api/staff/unmute', authRequired, staffRequired, async (req, res) => {
  const { userId } = req.body || {};
  const target = findUser(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  target.muted = false;
  target.muteExpires = null;
  await saveData(db);
  const io_ = req.app.get('io');
  io_.to(`user:${target.id}`).emit('moderation:unmuted', {});
  io_.emit('user:updated', publicUser(target));
  io_.emit('staff:log', { type: 'unmute', actor: req.user.username, target: target.username, at: new Date().toISOString() });
  res.json({ user: publicUser(target) });
});

app.post('/api/staff/ban', authRequired, staffRequired, async (req, res) => {
  const { userId, reason } = req.body || {};
  const target = findUser(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!canModerate(req.user, target)) return res.status(403).json({ error: "You can't moderate someone of equal or higher rank." });

  target.banned = true;
  const ip = target.lastIp || null;
  const ban = { id: uuid(), ip, userId: target.id, username: target.username, reason: reason || 'No reason given', bannedBy: req.user.username, timestamp: new Date().toISOString(), liftedAt: null };
  db.bans.push(ban);
  await saveData(db);

  const io_ = req.app.get('io');
  const sockets = await io_.fetchSockets();
  for (const s of sockets) {
    if (s.data.userId === target.id || (ip && s.data.ip === ip)) {
      s.emit('moderation:banned', { reason: ban.reason });
      s.disconnect(true);
    }
  }
  io_.emit('user:updated', publicUser(target));
  io_.emit('staff:log', { type: 'ban', actor: req.user.username, target: target.username, reason: ban.reason, ip, at: ban.timestamp });
  res.json({ ban, user: publicUser(target) });
});

app.post('/api/staff/unban', authRequired, staffRequired, async (req, res) => {
  const { banId } = req.body || {};
  const ban = db.bans.find(b => b.id === banId);
  if (!ban) return res.status(404).json({ error: 'Ban record not found.' });
  ban.liftedAt = new Date().toISOString();
  const target = findUser(ban.userId);
  if (target) target.banned = false;
  await saveData(db);
  const io_ = req.app.get('io');
  if (target) io_.emit('user:updated', publicUser(target));
  io_.emit('staff:log', { type: 'unban', actor: req.user.username, target: ban.username, ip: ban.ip, at: ban.liftedAt });
  res.json({ ban });
});

app.post('/api/staff/ban-ip', authRequired, staffRequired, async (req, res) => {
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'IP address is required.' });
  const ban = { id: uuid(), ip, userId: null, username: null, reason: reason || 'No reason given', bannedBy: req.user.username, timestamp: new Date().toISOString(), liftedAt: null };
  db.bans.push(ban);
  await saveData(db);
  const io_ = req.app.get('io');
  const sockets = await io_.fetchSockets();
  for (const s of sockets) {
    if (s.data.ip === ip) { s.emit('moderation:banned', { reason: ban.reason }); s.disconnect(true); }
  }
  io_.emit('staff:log', { type: 'ban-ip', actor: req.user.username, target: ip, reason: ban.reason, at: ban.timestamp });
  res.json({ ban });
});

app.post('/api/staff/set-nickname', authRequired, staffRequired, async (req, res) => {
  const { userId, nickname } = req.body || {};
  const target = findUser(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!canModerate(req.user, target) && target.id !== req.user.id) return res.status(403).json({ error: "You can't moderate someone of equal or higher rank." });
  const clean = (nickname || '').toString().trim().slice(0, 24);
  target.nickname = clean || null;
  await saveData(db);
  const io_ = req.app.get('io');
  io_.emit('user:updated', publicUser(target));
  io_.emit('staff:log', { type: 'nickname', actor: req.user.username, target: target.username, reason: clean ? `set nickname to "${clean}"` : 'cleared nickname', at: new Date().toISOString() });
  res.json({ user: publicUser(target) });
});

app.delete('/api/staff/messages/:id', authRequired, staffRequired, async (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  const author = findUser(msg.userId);
  if (author && !canModerate(req.user, author) && author.id !== req.user.id) {
    return res.status(403).json({ error: "You can't moderate someone of equal or higher rank." });
  }
  msg.deleted = true; msg.pinned = false; msg.content = '';
  await saveData(db);
  req.app.get('io').emit('message:deleted', { id: msg.id });
  res.json({ ok: true });
});

app.post('/api/staff/messages/:id/pin', authRequired, staffRequired, async (req, res) => {
  const msg = db.messages.find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  if (msg.deleted) return res.status(400).json({ error: "Can't pin a deleted message." });
  msg.pinned = !msg.pinned;
  await saveData(db);
  req.app.get('io').emit('message:updated', { id: msg.id, pinned: msg.pinned });
  res.json({ pinned: msg.pinned });
});

// ============================================================
// ADMIN+ ROUTES — roles, titles, events, theme, effects, channels(above)
// ============================================================
app.post('/api/staff/set-role', authRequired, adminRequired, async (req, res) => {
  const { userId, role } = req.body || {};
  if (!(role in RANKS)) return res.status(400).json({ error: 'Invalid role.' });
  const target = findUser(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });

  const cap = maxAssignableRole(req.user);
  if (!cap || RANKS[role] > RANKS[cap]) {
    return res.status(403).json({ error: `Your rank can only assign up to "${cap || 'nothing'}".` });
  }
  if (rankLevel(target) >= rankLevel(req.user)) {
    return res.status(403).json({ error: "You can't change the rank of someone at or above your own rank." });
  }

  target.role = role;
  if (role === 'user') target.staffTitle = null;
  await saveData(db);
  req.app.get('io').emit('user:updated', publicUser(target));
  req.app.get('io').emit('staff:log', { type: 'role', actor: req.user.username, target: target.username, reason: `set role to ${role}`, at: new Date().toISOString() });
  res.json({ user: publicUser(target) });
});

app.post('/api/staff/set-title', authRequired, adminRequired, async (req, res) => {
  const { userId, title } = req.body || {};
  const target = findUser(userId);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (!isStaff(target)) return res.status(400).json({ error: 'Only staff can have a badge title.' });
  if (rankLevel(target) >= rankLevel(req.user) && target.id !== req.user.id) {
    return res.status(403).json({ error: "You can't edit the title of someone at or above your own rank." });
  }
  target.staffTitle = (title || '').toString().slice(0, 60) || null;
  await saveData(db);
  req.app.get('io').emit('user:updated', publicUser(target));
  res.json({ user: publicUser(target) });
});

app.post('/api/staff/events', authRequired, staffRequired, async (req, res) => {
  const { title, description, date } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const event = { id: uuid(), title, description: description || '', date: date || null, createdBy: req.user.username, createdAt: new Date().toISOString() };
  db.events.push(event);
  await saveData(db);
  req.app.get('io').emit('events:updated', db.events);
  res.json({ event });
});

app.delete('/api/staff/events/:id', authRequired, staffRequired, async (req, res) => {
  db.events = db.events.filter(e => e.id !== req.params.id);
  await saveData(db);
  req.app.get('io').emit('events:updated', db.events);
  res.json({ ok: true });
});

app.post('/api/staff/effect', authRequired, adminRequired, (req, res) => {
  const { type, seconds } = req.body || {};
  if (!EFFECT_TYPES.includes(type)) return res.status(400).json({ error: `Effect must be one of: ${EFFECT_TYPES.join(', ')}` });
  const duration = Math.min(Math.max(parseInt(seconds, 10) || 20, 3), 120);
  req.app.get('io').emit('effect:trigger', { type, seconds: duration, by: req.user.username, at: new Date().toISOString() });
  res.json({ ok: true, type, seconds: duration });
});

app.post('/api/staff/theme', authRequired, adminRequired, async (req, res) => {
  const { theme, siteName, motd } = req.body || {};
  if (theme) db.settings.theme = theme;
  if (siteName) db.settings.siteName = siteName;
  if (typeof motd === 'string') db.settings.motd = motd;
  await saveData(db);
  req.app.get('io').emit('settings:updated', db.settings);
  res.json({ settings: db.settings });
});

// ============================================================
// DEV+ ROUTES — server stats / developer tab
// ============================================================
app.get('/api/staff/dev/stats', authRequired, devRequired, async (req, res) => {
  const io_ = req.app.get('io');
  const sockets = await io_.fetchSockets();
  res.json({
    stats: {
      uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
      nodeVersion: process.version,
      platform: `${os.type()} ${os.release()}`,
      memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      onlineSockets: sockets.length,
      totalUsers: db.users.length,
      totalStaff: db.users.filter(isStaff).length,
      totalMessages: db.messages.length,
      totalChannels: db.channels.length,
      totalBans: db.bans.filter(b => !b.liftedAt).length,
      totalWarnings: db.warnings.length,
      openReports: db.reports.filter(r => !r.resolved).length
    }
  });
});

// ============================================================
// OWNER-ONLY ROUTES — danger zone
// ============================================================
app.post('/api/staff/owner/wipe-warnings', authRequired, ownerRequired, async (req, res) => {
  db.warnings = [];
  await saveData(db);
  req.app.get('io').emit('staff:log', { type: 'danger', actor: req.user.username, target: 'all warnings', reason: 'wiped warning history', at: new Date().toISOString() });
  res.json({ ok: true });
});

app.post('/api/staff/owner/wipe-bans', authRequired, ownerRequired, async (req, res) => {
  db.bans.forEach(b => { if (!b.liftedAt) b.liftedAt = new Date().toISOString(); });
  db.users.forEach(u => { u.banned = false; });
  await saveData(db);
  const io_ = req.app.get('io');
  io_.emit('staff:log', { type: 'danger', actor: req.user.username, target: 'all bans', reason: 'lifted every active ban', at: new Date().toISOString() });
  db.users.forEach(u => io_.emit('user:updated', publicUser(u)));
  res.json({ ok: true });
});

app.delete('/api/staff/owner/users/:id', authRequired, ownerRequired, async (req, res) => {
  const target = findUser(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't delete your own account this way." });
  if (rankLevel(target) >= rankLevel(req.user)) return res.status(403).json({ error: "Can't delete someone at or above your own rank." });

  db.users = db.users.filter(u => u.id !== target.id);
  db.messages.forEach(m => { if (m.userId === target.id) { m.deleted = true; m.content = ''; m.pinned = false; } });
  await saveData(db);
  const io_ = req.app.get('io');
  const sockets = await io_.fetchSockets();
  for (const s of sockets) { if (s.data.userId === target.id) s.disconnect(true); }
  io_.emit('staff:log', { type: 'danger', actor: req.user.username, target: target.username, reason: 'account deleted', at: new Date().toISOString() });
  res.json({ ok: true });
});

// ============================================================
// SERVER + SOCKET.IO
// ============================================================
const server = http.createServer(app);
const ioServer = new Server(server, { cors: { origin: '*' } });
app.set('io', ioServer);

ioServer.use((socket, next) => {
  const ip = getSocketIp(socket);
  if (isIpBanned(ip)) return next(new Error('banned'));
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = findUser(payload.id);
    if (!user) return next(new Error('unauthorized'));
    if (user.banned) return next(new Error('banned'));
    socket.data.userId = user.id;
    socket.data.ip = ip;
    user.lastIp = ip;
    next();
  } catch (e) {
    next(new Error('unauthorized'));
  }
});

ioServer.on('connection', (socket) => {
  const user = findUser(socket.data.userId);
  if (!user) return socket.disconnect(true);

  socket.join(`user:${user.id}`);
  if (isStaff(user)) socket.join('staff-room');
  saveData(db);

  broadcastPresence();

  socket.on('chat:message', async (payload, ack) => {
    const fresh = findUser(socket.data.userId);
    if (!fresh || fresh.banned) return socket.disconnect(true);
    if (fresh.muted) {
      if (fresh.muteExpires && new Date(fresh.muteExpires) < new Date()) {
        fresh.muted = false; fresh.muteExpires = null; await saveData(db);
      } else {
        return ack && ack({ error: 'You are muted.' });
      }
    }
    const channelId = findChannel(payload?.channelId) ? payload.channelId : 'general';
    const text = (payload?.content || '').toString().slice(0, 2000);
    const type = ['text', 'image', 'gif'].includes(payload?.type) ? payload.type : 'text';
    if (type === 'text' && !text.trim()) return ack && ack({ error: 'Empty message.' });

    const message = {
      id: uuid(), userId: fresh.id, username: fresh.username, displayName: displayName(fresh),
      role: fresh.role, staffTitle: fresh.staffTitle || null, avatarColor: fresh.avatarColor, avatarUrl: fresh.avatarUrl || null,
      channelId, type, content: text, url: type !== 'text' ? (payload.url || '') : null,
      timestamp: new Date().toISOString(), deleted: false, pinned: false
    };
    db.messages.push(message);
    if (db.messages.length > 4000) db.messages = db.messages.slice(-4000);
    await saveData(db);
    ioServer.emit('chat:message', message);
    ack && ack({ ok: true, message });
  });

  socket.on('disconnect', () => broadcastPresence());

  function broadcastPresence() {
    ioServer.fetchSockets().then(sockets => {
      const onlineIds = new Set(sockets.map(s => s.data.userId));
      const online = [...onlineIds].map(id => publicUser(findUser(id))).filter(Boolean);
      ioServer.emit('presence:update', online);
    });
  }
});

server.listen(PORT, () => {
  console.log(`Signal Room running at https://chat-room-vx3s.onrender.com`);
  console.log(`Seed owner login -> username: admin  password: admin123  (change this!)`);
});
