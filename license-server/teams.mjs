// license-server/teams.mjs — 团队版席位核心（服务端）
//
// 模型：一个团队 = 一个 teamId + 席位上限 seats（null 表示不限）。
// 成员在本机激活时调用 /api/team/activate(teamId, machineCode)，
// 服务端发放「绑定该机器码、并带 teamId」的令牌，并在注册表占一个席位。
// 同一机器码重复激活为幂等（刷新席位，不重复计数）。
// 管理员可在后台回收席位（同时吊销该成员令牌，使其本机激活失效 —— 与解绑/漂移模型一致）。
//
// 客户端「多账号/子账号控制台」与运营工具属于后续重活，本模块只提供可测的服务端核心。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { issue, revokeToken } from './lib.mjs';
import { resolvePlan } from '../electron/plans.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEAMS_FILE = path.join(__dirname, 'teams.json');

function loadTeams() {
  try {
    return JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveTeams(t) {
  fs.writeFileSync(TEAMS_FILE, JSON.stringify(t, null, 2));
}

const TEAM_DEFAULT_SEATS = Number(process.env.TEAM_DEFAULT_SEATS || 20);

export function createTeam({ plan = 'team', billing = 'monthly', seats = null } = {}) {
  resolvePlan(plan);
  // team 计划默认不限席位（null）；其他计划用其 accounts 上限作为席位。
  let s = seats;
  if (s == null) {
    const p = resolvePlan(plan);
    s = p.key === 'team' ? null : (typeof p.accounts === 'number' ? p.accounts : TEAM_DEFAULT_SEATS);
  }
  const teamId = 'T' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
  const team = {
    teamId,
    plan,
    billing,
    seats: s, // null = 不限
    createdAt: Date.now(),
    members: [], // { machineCode, jti, activatedAt }
  };
  const all = loadTeams();
  all[teamId] = team;
  saveTeams(all);
  return team;
}

export function teamInfo(teamId) {
  const t = loadTeams()[teamId];
  if (!t) return null;
  const used = t.members.length;
  return {
    teamId: t.teamId,
    plan: t.plan,
    billing: t.billing,
    seats: t.seats,
    used,
    available: t.seats == null ? null : Math.max(0, t.seats - used),
    members: t.members,
  };
}

// 成员激活：占用一个席位，发放绑定机器码+teamId 的令牌。同机器码幂等。
export function activateSeat(teamId, machineCode) {
  if (!machineCode) throw new Error('machineCode required');
  const all = loadTeams();
  const t = all[teamId];
  if (!t) throw new Error('team-not-found');
  if (t.seats != null) {
    const used = t.members.filter((m) => m.machineCode !== machineCode).length;
    if (used >= t.seats) throw new Error('seats-exhausted');
  }
  // 若已存在该机器码，先吊销旧令牌（刷新席位，避免重复计数）
  const existing = t.members.find((m) => m.machineCode === machineCode);
  if (existing) revokeToken(existing.jti);
  const jti = crypto.randomBytes(8).toString('hex');
  const token = issue(t.plan, t.billing, machineCode, jti, { teamId });
  t.members = t.members.filter((m) => m.machineCode !== machineCode);
  t.members.push({ machineCode, jti, activatedAt: Date.now() });
  saveTeams(all);
  return { token, seats: t.seats, available: t.seats == null ? null : Math.max(0, t.seats - t.members.length), used: t.members.length };
}

// 回收席位：同时吊销该成员令牌，使其本机激活失效。
export function revokeSeat(teamId, machineCode) {
  const all = loadTeams();
  const t = all[teamId];
  if (!t) throw new Error('team-not-found');
  const m = t.members.find((x) => x.machineCode === machineCode);
  if (!m) return false;
  revokeToken(m.jti);
  t.members = t.members.filter((x) => x.machineCode !== machineCode);
  saveTeams(all);
  return true;
}
