// Hoster24 保活：真登录进服待一会儿再退出，让"无人 12 小时自动停服"计时被重置。
//
// 两种运行方式（同一份代码）：
//   node src/keepalive.js --once   只跑一轮就退出（GitHub Actions / cron 用）
//   node src/keepalive.js          守护模式：循环 [登录待 STAY_MIN → 睡 INTERVAL_H]，失败则 RETRY_MIN 后重试
//
// 设计要点：
// 1. 先做一次 Server List Ping：已有真人在线就跳过本轮（真人自己就在重置计时，也避免互顶）。
// 2. 用 minecraft-protocol 裸客户端，只做 登录 → 确认传送 → 应答 keepalive，不发任何移动包
//    （移动包经 ViaBackwards 翻译后会被 26.x 服务器判 Invalid move player 秒踢）。
// 3. 客户端协议版本写死 MC_VERSION（默认 1.21.11），由服务器端 ViaBackwards 翻译。
const net = require('net')
const mc = require('minecraft-protocol')

const cfg = {
  host: process.env.MC_HOST || 'server.hoster24.org',
  port: parseInt(process.env.MC_PORT || '24990', 10),
  user: process.env.MC_USER || 'qx47_kp9z2',
  version: process.env.MC_VERSION || '1.21.11',
  stayMs: parseFloat(process.env.STAY_MIN || '20') * 60 * 1000,
  intervalMs: parseFloat(process.env.INTERVAL_H || '4') * 3600 * 1000,
  retryMs: parseFloat(process.env.RETRY_MIN || '10') * 60 * 1000
}
const ONCE = process.argv.includes('--once')

const log = (...a) => console.log(new Date().toISOString(), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 极简 Server List Ping（版本无关，只读 players.online） ----------
function varint (n) {
  const out = []
  let v = n >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return Buffer.from(out)
}
const mcString = (s) => {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([varint(b.length), b])
}
const mcPacket = (id, payload) => {
  const body = Buffer.concat([varint(id), payload])
  return Buffer.concat([varint(body.length), body])
}

function statusPing () {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(cfg.port, cfg.host)
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('ping timeout')) }, 10000)
    let buf = Buffer.alloc(0)
    sock.on('connect', () => {
      const hs = mcPacket(0x00, Buffer.concat([
        varint(47), mcString(cfg.host),
        Buffer.from([(cfg.port >> 8) & 0xff, cfg.port & 0xff]),
        varint(1)
      ]))
      sock.write(Buffer.concat([hs, mcPacket(0x00, Buffer.alloc(0))]))
    })
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      try {
        let off = 0
        const rv = () => {
          let num = 0; let shift = 0; let b
          do { b = buf[off++]; num |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
          return num
        }
        const len = rv()
        if (buf.length < off + len) return
        rv() // packet id
        const slen = rv()
        const json = buf.slice(off, off + slen).toString('utf8')
        clearTimeout(timer)
        sock.destroy()
        resolve(JSON.parse(json))
      } catch { /* 半包，继续等 */ }
    })
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}

// ---------- 一轮保活：返回 'ok' | 'skipped' | 'failed' ----------
async function runOnce () {
  let status
  try {
    status = await statusPing()
  } catch (e) {
    log(`status ping ${cfg.host}:${cfg.port} failed:`, e.message)
    return 'failed'
  }
  const online = status && status.players ? status.players.online : 0
  log('players online:', online)
  if (online > 0) {
    log('someone is playing, skip this round')
    return 'skipped'
  }

  return new Promise((resolve) => {
    const client = mc.createClient({
      host: cfg.host,
      port: cfg.port,
      username: cfg.user,
      auth: 'offline',
      version: cfg.version
      // keepAlive 默认 true，协议库自动应答服务器 keepalive
    })

    let done = false
    let spawned = false
    const timers = []
    const finish = (result, msg) => {
      if (done) return
      done = true
      log(msg)
      timers.forEach(clearTimeout)
      try { client.end() } catch {}
      setTimeout(() => resolve(result), 500)
    }

    client.once('login', () => {
      log('logged in as', cfg.user)
      timers.push(setTimeout(() => finish('ok', 'stay complete, leaving'), cfg.stayMs))
      timers.push(setTimeout(() => finish('failed', 'hard timeout'), cfg.stayMs + 5 * 60 * 1000))
    })

    // 只确认传送，绝不回移动包
    client.on('position', (p) => {
      try { client.write('teleport_confirm', { teleportId: p.teleportId }) } catch {}
      if (!spawned) {
        spawned = true
        log('spawned; staying', (cfg.stayMs / 60000).toFixed(1), 'min')
      }
    })

    client.on('kick_disconnect', (p) => finish('failed', 'kicked: ' + JSON.stringify(p && p.reason)))
    client.on('disconnect', (p) => finish('failed', 'disconnected: ' + JSON.stringify(p && p.reason)))
    client.on('error', (e) => finish('failed', 'error: ' + (e && e.message)))
    client.on('end', () => finish('failed', 'connection ended early'))
  })
}

// ---------- 入口 ----------
async function main () {
  log(`target ${cfg.host}:${cfg.port} user=${cfg.user} version=${cfg.version} mode=${ONCE ? 'once' : 'daemon'}`)
  if (ONCE) {
    const r = await runOnce()
    process.exit(r === 'failed' ? 1 : 0)
  }
  for (;;) {
    const r = await runOnce()
    const wait = r === 'failed' ? cfg.retryMs : cfg.intervalMs
    log(`round ${r}, next in ${(wait / 60000).toFixed(0)} min`)
    await sleep(wait)
  }
}

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
main()
