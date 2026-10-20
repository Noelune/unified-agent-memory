#!/usr/bin/env node
/**
 * 各渠道下载 / 使用量统计。
 *
 * 这个脚本只做一件事：把散在不同地方的"有人在用我这个包"的信号拉到一个地方，
 * 算清楚每一条的口径，然后生成一份能看的看板。
 *
 * 数据来源（全部是只读的公开接口 + 本机 gh 凭据）：
 *   1. npm registry 下载计数  —— 公开 API，任何人可查
 *   2. GitHub clone / view    —— 需要仓库写权限，走本机 `gh` 登录态，只保留 14 天
 *   3. GitHub Release 资产下载 —— 公开 API
 *   4. GitHub star / fork     —— 公开 API
 *   5. 本机装了什么版本        —— 读本地 profile
 *
 * 用法：
 *   node scripts/stats.mjs              文本报告 + 生成 .stats/stats.html
 *   node scripts/stats.mjs --no-open    只生成，不尝试打开浏览器
 *   node scripts/stats.mjs --json       只吐原始 JSON（给别的脚本吃）
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = process.cwd()
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const REPO = (pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/^https?:\/\/github\.com\//, '')
  .replace(/\.git$/, '')
  .replace(/\/$/, '')

const OUT_DIR = path.join(ROOT, '.stats')
const OUT_HTML = path.join(OUT_DIR, 'stats.html')

const DAY = 86400000
const now = new Date()
const iso = (d) => d.toISOString().slice(0, 10)
const daysAgo = (n) => new Date(now.getTime() - n * DAY)

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

/** 走本机 gh 凭据访问 GitHub API。没装 gh / 没登录就返回 null。 */
function gh(endpoint) {
  try {
    const out = execFileSync('gh', ['api', endpoint], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
    })
    return JSON.parse(out)
  } catch {
    return null
  }
}

// ── npm ──────────────────────────────────────────────────────────────────────

async function readNpm(name) {
  const base = 'https://api.npmjs.org'
  const q = encodeURIComponent(name)

  const point = async (period) => {
    try {
      const r = await getJSON(`${base}/downloads/point/${period}/${q}`)
      return r.downloads ?? 0
    } catch {
      return 0
    }
  }

  const [day, week, month] = await Promise.all([
    point('last-day'),
    point('last-week'),
    point('last-month'),
  ])

  // 全量区间：npm 的数据从 2015-01-10 开始，包不存在就是 0
  let total = 0
  let totalStart = null
  try {
    const r = await getJSON(`${base}/downloads/point/2015-01-10:${iso(now)}/${q}`)
    total = r.downloads ?? 0
    totalStart = r.start ?? null
  } catch {
    /* 保持 0 */
  }

  // 近 30 天逐日
  let daily = []
  try {
    const r = await getJSON(`${base}/downloads/range/last-month/${q}`)
    daily = (r.downloads ?? []).map((d) => ({ date: d.day, n: d.downloads }))
  } catch {
    daily = []
  }

  // 近一周按版本拆
  let versions = []
  try {
    const r = await getJSON(`${base}/versions/${q}/last-week`)
    versions = Object.entries(r.downloads ?? {})
      .map(([v, n]) => ({ v, n }))
      .sort((a, b) => b.n - a.n)
  } catch {
    versions = []
  }

  return { day, week, month, total, totalStart, daily, versions }
}

// ── GitHub ───────────────────────────────────────────────────────────────────

function readGithub(repo) {
  if (!repo) return { available: false, reason: 'package.json 里没有 repository 字段' }

  const meta = gh(`repos/${repo}`)
  if (!meta) return { available: false, reason: 'gh 未登录 / 无权限 / 不是 GitHub 仓库' }

  const views = gh(`repos/${repo}/traffic/views`) ?? { count: 0, uniques: 0, views: [] }
  const clones = gh(`repos/${repo}/traffic/clones`) ?? { count: 0, uniques: 0, clones: [] }
  const referrers = gh(`repos/${repo}/traffic/popular/referrers`) ?? []

  // Release 附件下载次数（没有附件就是 0——源码 tarball 走 codeload，不计入）
  let releases = []
  try {
    const list = gh(`repos/${repo}/releases`) ?? []
    releases = list.map((r) => ({
      tag: r.tag_name,
      at: (r.published_at ?? '').slice(0, 10),
      downloads: (r.assets ?? []).reduce((a, x) => a + (x.download_count ?? 0), 0),
      assets: (r.assets ?? []).length,
    }))
  } catch {
    releases = []
  }

  return {
    available: true,
    stars: meta.stargazers_count ?? 0,
    forks: meta.forks_count ?? 0,
    watchers: meta.subscribers_count ?? 0,
    issues: meta.open_issues_count ?? 0,
    createdAt: (meta.created_at ?? '').slice(0, 10),
    views: {
      count: views.count ?? 0,
      uniques: views.uniques ?? 0,
      daily: (views.views ?? []).map((v) => ({ date: v.timestamp.slice(0, 10), n: v.count, u: v.uniques })),
    },
    clones: {
      count: clones.count ?? 0,
      uniques: clones.uniques ?? 0,
      daily: (clones.clones ?? []).map((v) => ({ date: v.timestamp.slice(0, 10), n: v.count, u: v.uniques })),
    },
    referrers: referrers.map((r) => ({ name: r.referrer, count: r.count, uniques: r.uniques })),
    releaseDownloads: releases.reduce((a, r) => a + r.downloads, 0),
    releases,
  }
}

// ── 本机 ─────────────────────────────────────────────────────────────────────

function readLocal(name) {
  const profiles = [
    path.join(os.homedir(), '.dsh', 'profiles', 'desktop'),
  ]
  for (const p of profiles) {
    const manifest = path.join(p, 'node_modules', name, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        return { profile: p, version: JSON.parse(fs.readFileSync(manifest, 'utf8')).version }
      } catch {
        /* 下一个 */
      }
    }
  }
  return null
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────

const npm = await readNpm(pkg.name)
const github = readGithub(REPO)
const local = readLocal(pkg.name)

const data = {
  generatedAt: new Date().toISOString(),
  pkg: { name: pkg.name, version: pkg.version, repo: REPO },
  npm,
  github,
  local,
}

// 峰值日
const peak = npm.daily.reduce((a, d) => (d.n > a.n ? d : a), { date: '-', n: 0 })

// ── 文本报告 ──────────────────────────────────────────────────────────────────

const pad = (s, n) => String(s).padStart(n)
const line = (label, value, note = '') =>
  console.log(`  ${label.padEnd(22)}${pad(value, 8)}   ${note}`)

function report() {
  console.log('')
  console.log(`  ${pkg.name}  下载与使用统计`)
  console.log(`  ${'-'.repeat(60)}`)
  console.log('')

  console.log('  npm registry（公开可查，任何人装一次 +1）')
  line('累计下载', npm.total, npm.totalStart ? `自 ${npm.totalStart}` : '')
  line('近 30 天', npm.month)
  line('近 7 天', npm.week)
  line('昨天', npm.day)
  line('30 天峰值日', peak.n, peak.date)
  console.log('')

  if (npm.versions.length) {
    console.log('  近 7 天按版本')
    for (const v of npm.versions) line(`  ${v.v}`, v.n)
    console.log('')
  }

  if (github.available) {
    console.log('  GitHub（clone / view 只保留 14 天）')
    line('近 14 天克隆', github.clones.count, `${github.clones.uniques} 个独立来源`)
    line('近 14 天浏览', github.views.count, `${github.views.uniques} 个独立 IP`)
    line('Release 附件下载', github.releaseDownloads)
    line('Star', github.stars)
    line('Fork', github.forks)
    line('Watch', github.watchers)
    console.log('')
    if (github.referrers.length) {
      console.log('  访问来源')
      for (const r of github.referrers) line(`  ${r.name}`, r.count, `${r.uniques} 独立`)
      console.log('')
    }
  } else {
    console.log(`  GitHub：不可用（${github.reason}）`)
    console.log('')
  }

  console.log('  本机')
  line('profile 装的版本', local ? local.version : '(未安装)')
  line('仓库最新版本', pkg.version)
  console.log('')

  console.log('  口径（这些数字各自意味着什么）')
  console.log('  · npm 的计数是「tarball 被下载的次数」，不是人数：重装、CI、')
  console.log('    镜像回源、你本机反复 pnpm add 都会各算一次。')
  console.log('  · 国内 npmmirror 等镜像的下载不计入 npm 官方统计。')
  console.log('  · GitHub clone 含你自己的 git fetch/pull/CI，14 天后自动归零。')
  console.log('  · source tarball 走 codeload，没有单独接口，只有 Release 附件有数。')
  console.log('')
  console.log(`  看板：${path.relative(ROOT, OUT_HTML)}`)
  console.log('')
}

// ── HTML 看板 ─────────────────────────────────────────────────────────────────

function renderHTML() {
  const N = (n) => Number(n ?? 0).toLocaleString('en-US')

  const bars = (series, key, cls = '') => {
    if (!series.length) return '<p class="empty">这个渠道没有数据</p>'
    const max = Math.max(...series.map((d) => d[key] ?? 0), 1)
    return (
      '<div class="bars ' + cls + '">' +
      series
        .map((d) => {
          const h = Math.max(2, Math.round(((d[key] ?? 0) / max) * 100))
          return `<i style="height:${h}%" title="${d.date}：${d[key] ?? 0}"></i>`
        })
        .join('') +
      '</div>'
    )
  }

  const versionBars = npm.versions.length
    ? npm.versions
        .map((v) => {
          const max = Math.max(...npm.versions.map((x) => x.n), 1)
          const w = Math.max(2, Math.round((v.n / max) * 100))
          return `<div class="vrow"><span class="vtag">${v.v}</span>
            <span class="vtrack"><i style="width:${w}%"></i></span>
            <span class="vnum">${N(v.n)}</span></div>`
        })
        .join('')
    : '<p class="empty">这个渠道没有数据</p>'

  const ghCard = github.available
    ? `
    <div class="card">
      <h2>GitHub <em>clone / view 只保留 14 天</em></h2>
      <div class="pairs">
        <div><b>${N(github.clones.count)}</b><span>克隆次数</span></div>
        <div><b>${N(github.clones.uniques)}</b><span>独立来源</span></div>
        <div><b>${N(github.views.count)}</b><span>页面浏览</span></div>
        <div><b>${N(github.views.uniques)}</b><span>独立访客</span></div>
      </div>
      ${bars(github.clones.daily, 'n')}
      <div class="pairs small">
        <div><b>${N(github.stars)}</b><span>Star</span></div>
        <div><b>${N(github.forks)}</b><span>Fork</span></div>
        <div><b>${N(github.watchers)}</b><span>Watch</span></div>
        <div><b>${N(github.releaseDownloads)}</b><span>Release 附件</span></div>
      </div>
      ${
        github.referrers.length
          ? '<h3>访问来源</h3><ul class="refs">' +
            github.referrers
              .map((r) => `<li><span>${r.name}</span><b>${N(r.count)}</b><em>${N(r.uniques)} 独立</em></li>`)
              .join('') +
            '</ul>'
          : ''
      }
      ${
        github.releases.length
          ? '<h3>版本发布</h3><ul class="refs">' +
            github.releases
              .slice(0, 6)
              .map((r) => `<li><span>${r.tag}</span><b>${N(r.downloads)}</b><em>${r.at}</em></li>`)
              .join('') +
            '</ul>'
          : ''
      }
    </div>`
    : `<div class="card muted"><h2>GitHub</h2><p class="empty">${github.reason}</p></div>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pkg.name} 下载与使用统计</title>
<style>
  :root{
    --bg:#f7f8fa; --card:#fff; --ink:#11151c; --ink2:#5b6472; --ink3:#8b94a3;
    --line:#e6e9ee; --accent:#2f6bff; --accent2:#12a37a; --warn:#b26b00;
    --radius:14px;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased;padding:40px 20px 64px}
  .wrap{max-width:1040px;margin:0 auto}
  header{margin-bottom:28px}
  h1{font-size:25px;margin:0 0 6px;letter-spacing:-.02em}
  h1 span{font-weight:400;color:var(--ink3)}
  .sub{color:var(--ink2);font-size:13.5px}
  .sub code{background:#eef1f6;padding:1px 6px;border-radius:5px;font-size:12.5px}
  .hero{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0 14px}
  .hero div{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px}
  .hero b{display:block;font-size:32px;line-height:1.15;letter-spacing:-.03em;
    font-variant-numeric:tabular-nums}
  .hero span{display:block;color:var(--ink3);font-size:12.5px;margin-top:4px}
  .hero .big b{color:var(--accent)}
  .grid{display:grid;grid-template-columns:1.35fr 1fr;gap:14px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
    padding:18px 20px 20px;margin-bottom:14px}
  .card h2{font-size:14px;margin:0 0 14px;letter-spacing:.01em;display:flex;align-items:baseline;gap:8px}
  .card h2 em{font-style:normal;font-weight:400;color:var(--ink3);font-size:12px}
  .card h3{font-size:12px;color:var(--ink3);margin:16px 0 8px;font-weight:600;
    letter-spacing:.06em;text-transform:uppercase}
  .bars{display:flex;align-items:flex-end;gap:3px;height:96px;margin:6px 0 2px;
    padding-top:4px;border-bottom:1px solid var(--line)}
  .bars i{flex:1;background:linear-gradient(180deg,#7fa6ff,#2f6bff);border-radius:3px 3px 0 0;
    min-height:2px;transition:none}
  .bars i:hover{background:#12a37a}
  .pairs{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
  .pairs.small{margin-top:16px}
  .pairs b{display:block;font-size:22px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .pairs span{color:var(--ink3);font-size:12px}
  .vrow{display:grid;grid-template-columns:58px 1fr 58px;align-items:center;gap:10px;
    margin-bottom:7px;font-size:12.5px}
  .vtag{color:var(--ink2);font-variant-numeric:tabular-nums}
  .vtrack{background:#eef1f6;border-radius:4px;height:9px;overflow:hidden}
  .vtrack i{display:block;height:100%;background:var(--accent2);border-radius:4px}
  .vnum{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink2)}
  .refs{list-style:none;margin:0;padding:0;font-size:13px}
  .refs li{display:grid;grid-template-columns:1fr 60px 70px;gap:8px;padding:5px 0;
    border-bottom:1px dashed var(--line)}
  .refs li:last-child{border-bottom:0}
  .refs b{text-align:right;font-variant-numeric:tabular-nums}
  .refs em{font-style:normal;color:var(--ink3);text-align:right;font-size:12px}
  .empty{color:var(--ink3);font-size:13px;margin:6px 0}
  .muted{opacity:.7}
  .note{background:#fffdf5;border:1px solid #f0e2bd;border-radius:var(--radius);
    padding:16px 20px;color:#5a4a20;font-size:13px;line-height:1.75}
  .note h2{color:#7a5c14;font-size:13px;margin:0 0 8px}
  .note ul{margin:0;padding-left:18px}
  .note li{margin-bottom:5px}
  footer{margin-top:22px;color:var(--ink3);font-size:12px;text-align:center}
  @media (max-width:820px){
    .hero{grid-template-columns:repeat(2,1fr)}
    .grid{grid-template-columns:1fr}
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${pkg.name} <span>· 下载与使用统计</span></h1>
    <div class="sub">
      ${github.available ? `<a href="https://github.com/${REPO}">${REPO}</a> · ` : ''}
      当前版本 <code>${pkg.version}</code> · 生成于 ${new Date(data.generatedAt).toLocaleString('zh-CN')}
    </div>
  </header>

  <div class="hero">
    <div class="big"><b>${N(npm.total)}</b><span>npm 累计下载</span></div>
    <div><b>${N(npm.month)}</b><span>近 30 天</span></div>
    <div><b>${N(npm.week)}</b><span>近 7 天</span></div>
    <div><b>${N(npm.day)}</b><span>昨天</span></div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>近 30 天每日下载 <em>峰值 ${N(peak.n)}（${peak.date}）</em></h2>
      ${bars(npm.daily, 'n')}
      <h3>近 7 天按版本</h3>
      ${versionBars}
    </div>
    ${ghCard}
  </div>

  <div class="note">
    <h2>这些数字各自意味着什么（别把它们相加）</h2>
    <ul>
      <li><b>npm 下载次数</b>不是人数：重装、CI 跑一次、镜像回源、你自己反复 <code>pnpm add</code> 都会各算一次。它衡量的是「这个包被拉取了多少次」，不是「多少人在用」。</li>
      <li>国内 <b>npmmirror</b> 等镜像的下载<b>不计入</b> npm 官方统计，所以真实拉取量只会比这多，不会少。</li>
      <li><b>GitHub clone</b> 含你自己的 <code>git fetch/pull</code> 与 CI，且只保留最近 14 天，归零不等于没人用。</li>
      <li>源码 <code>.tar.gz</code> 走 codeload，GitHub <b>没有</b>对应接口；只有 Release 附件才有下载计数（你没传附件，所以那栏是 0）。</li>
      <li>真正「装完在用」的证据只有<b>独立来源数</b>这一类去重指标：npm 侧没有 IP 维度，GitHub 侧 14 天 ${github.available ? N(github.clones.uniques) + ' 个独立克隆来源' : '无'}。</li>
    </ul>
  </div>

  <footer>
    本机 profile 安装版本：${local ? local.version : '未安装'} ·
    <code>node scripts/stats.mjs</code> 刷新
  </footer>
</div>
</body>
</html>`
}

// ── 输出 ──────────────────────────────────────────────────────────────────────

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(data, null, 2))
} else {
  report()
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_HTML, renderHTML(), 'utf8')
  if (!process.argv.includes('--no-open')) {
    console.log(`  已生成 ${OUT_HTML}`)
  }
}
