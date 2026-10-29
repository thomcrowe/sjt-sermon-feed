// GET /api/latest-stream
// Looks at the channel's "Live" tab and returns what the website's player should show:
//   live      the stream that is live right now (or null)
//   upcoming  the next scheduled stream (or null)
//   latest    the most recent finished livestream (or null)
// Uses YouTube's public channel page only: no API key.
//
// Optional environment variable (Vercel → Project → Settings → Environment Variables):
//   CHANNEL_ID  defaults to Saint John's channel

const CHANNEL = process.env.CHANNEL_ID || "UCkmZjJp4M93UZUfy3z7Cisw"
// Only Sunday services count as the "latest" recording. Override with SERVICE_TITLE_MATCH (a regular expression).
const SERVICE = new RegExp(process.env.SERVICE_TITLE_MATCH || "eucharist|evensong", "i")

const HEADERS = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    cookie: "CONSENT=YES+cb; SOCS=CAI",
}
const jsonString = s => { try { return JSON.parse('"' + s + '"') } catch { return s } }

async function get(url) {
    const r = await fetch(url, { headers: HEADERS })
    if (!r.ok) throw new Error(url.replace("https://www.youtube.com", "") + " " + r.status)
    return r.text()
}

// YouTube renders the Live tab in one of two layouts: older "videoRenderer" blocks or newer
// "lockupViewModel" blocks. Read the bits we need from whichever is present.
function parseStreams(html) {
    const out = []
    const seen = new Set()
    const add = v => { if (v.id && !seen.has(v.id)) { seen.add(v.id); out.push(v) } }

    for (const c of html.split('"videoRenderer":{"videoId":"').slice(1)) {
        const id = c.slice(0, 11)
        if (!/^[\w-]{11}$/.test(id)) continue
        const block = c.slice(0, 6000)
        const t = block.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/) || block.match(/"title":\{"simpleText":"((?:[^"\\]|\\.)*)"/)
        const upcoming = block.match(/"upcomingEventData":\{"startTime":"(\d+)"/)
        const liveNow = /"style":"LIVE"|BADGE_STYLE_TYPE_LIVE_NOW/.test(block) && !upcoming
        const ago = block.match(/"publishedTimeText":\{"simpleText":"((?:[^"\\]|\\.)*)"/)
        const len = block.match(/"lengthText":\{[^}]*"simpleText":"([\d:]+)"/)
        add({ id, title: t ? jsonString(t[1]) : "", status: liveNow ? "live" : upcoming ? "upcoming" : "past", startTime: upcoming ? new Date(+upcoming[1] * 1000).toISOString() : null, published: ago ? jsonString(ago[1]) : "", length: len ? len[1] : "" })
    }

    for (const c of html.split('"lockupViewModel":{"contentImage"').slice(1)) {
        const block = c.slice(0, 15000)
        const idm = block.match(/"contentId":"([\w-]{11})"/) || block.match(/\/vi\/([\w-]{11})\//)
        if (!idm) continue
        const t = block.match(/"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/)
        const badges = [...block.matchAll(/"thumbnailBadgeViewModel":\{[\s\S]{0,400}?"text":"((?:[^"\\]|\\.)*)"[\s\S]{0,80}?"badgeStyle":"([A-Z_]+)"/g)].map(m => [jsonString(m[1]), m[2]])
        const rows = block.slice(Math.max(0, block.indexOf('"metadataRows"')), block.indexOf('"metadataRows"') + 3000)
        const parts = block.includes('"metadataRows"') ? [...rows.matchAll(/"text":\{"content":"((?:[^"\\]|\\.)*)"/g)].map(m => jsonString(m[1])) : []
        const meta = parts.join(" · ")
        const badgeText = badges.map(b => b[0]).join(" ")
        const liveNow = badges.some(b => /LIVE/.test(b[1]) && !/UPCOMING/.test(b[1])) || /^LIVE$/i.test(badgeText.trim()) || /watching/i.test(meta)
        const upcoming = /scheduled for|premieres|upcoming/i.test(meta + " " + badgeText)
        const time = badges.find(b => /^\d+(:\d\d)+$/.test(b[0]))
        const ago = parts.find(p => /ago|streamed/i.test(p)) || ""
        add({ id: idm[1], title: t ? jsonString(t[1]) : "", status: liveNow ? "live" : upcoming ? "upcoming" : "past", startTime: null, scheduled: upcoming ? parts.find(p => /scheduled|premieres/i.test(p)) || "" : "", published: ago, length: time ? time[0] : "" })
    }
    return out
}

const shape = v => v && ({
    id: v.id,
    title: v.title,
    url: "https://youtu.be/" + v.id,
    thumbnail: "https://i.ytimg.com/vi/" + v.id + "/hqdefault.jpg",
    ...(v.startTime ? { startTime: v.startTime } : {}),
    ...(v.scheduled ? { scheduled: v.scheduled } : {}),
    ...(v.published ? { published: v.published } : {}),
    ...(v.length ? { length: v.length } : {}),
})

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    let streams = []
    const errors = []
    const debug = []
    for (const url of ["https://www.youtube.com/channel/" + CHANNEL + "/streams", "https://www.youtube.com/@sjtulsa/streams"]) {
        try {
            const html = await get(url)
            streams = parseStreams(html)
            debug.push({ url, bytes: html.length, renderers: (html.match(/"videoRenderer"/g) || []).length, lockups: (html.match(/"lockupViewModel"/g) || []).length, consent: /consent\.youtube|before you continue/i.test(html) })
            if (streams.length) break
        } catch (e) { errors.push(String(e.message || e)) }
    }
    if (!streams.length) {
        // 200 so the site can fall back quietly; details explain what went wrong.
        res.setHeader("Cache-Control", "s-maxage=60")
        res.status(200).json({ live: null, upcoming: null, latest: null, error: errors.join("; ") || "no streams found", debug })
        return
    }
    const live = streams.find(s => s.status === "live") || null
    const upcoming = streams.filter(s => s.status === "upcoming").sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""))[0] || null
    const latest = streams.find(s => s.status === "past" && SERVICE.test(s.title)) || null
    const latestAny = streams.find(s => s.status === "past") || null
    // Short cache so the site notices quickly when a stream starts.
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300")
    res.status(200).json({
        live: shape(live),
        upcoming: shape(upcoming),
        latest: shape(latest),
        latestAny: shape(latestAny),
        channelUrl: "https://www.youtube.com/channel/" + CHANNEL + "/streams",
        updated: new Date().toISOString(),
        ...(errors.length ? { notes: errors.join("; ") } : {}),
    })
}
