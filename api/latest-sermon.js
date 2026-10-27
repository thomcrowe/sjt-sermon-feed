// GET /api/latest-sermon
// Returns the newest sermon by pairing the Spotify podcast RSS feed with the
// YouTube channel's uploads feed. No API keys needed.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   SERMON_RSS_URL      optional override; defaults to the SoundCloud feed
//   YOUTUBE_CHANNEL_ID  optional override; defaults to the Saint John's channel
//   YOUTUBE_FILTER      optional: only use videos whose title contains this text (e.g. "Sermon")

const UA = { "user-agent": "SaintJohnsSermonFeed/1.0 (+https://sjtulsa.org)" }

function decode(s = "") {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
        .replace(/&amp;/g, "&")
        .trim()
}
const strip = (html = "") => decode(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim()
const tag = (xml, name) => { const m = xml.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i")); return m ? decode(m[1]) : "" }
const attr = (xml, name, a) => { const m = xml.match(new RegExp("<" + name + "\\s[^>]*" + a + "=\"([^\"]*)\"", "i")); return m ? decode(m[1]) : "" }
const items = (xml, name) => xml.split(new RegExp("<" + name + "[\\s>]", "i")).slice(1).map(s => "<" + name + " " + s)

function minutes(d) {
    if (!d) return ""
    const p = String(d).split(":").map(Number)
    const secs = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0]
    return secs ? Math.round(secs / 60) + " min" : ""
}

async function podcast(url) {
    if (!url) return []
    const r = await fetch(url, { headers: UA })
    if (!r.ok) throw new Error("RSS " + r.status)
    const xml = await r.text()
    return items(xml, "item").map(it => {
        const description = tag(it, "description") || tag(it, "itunes:summary")
        return {
            title: tag(it, "title"),
            date: new Date(tag(it, "pubDate")).toISOString(),
            summary: strip(description).split("\n").find(l => l.trim().length > 40) || strip(description),
            description: strip(description),
            rawDescription: decode(description),
            audioUrl: attr(it, "enclosure", "url"),
            length: minutes(tag(it, "itunes:duration")),
            episodeUrl: tag(it, "link"),
            image: attr(it, "itunes:image", "href"),
        }
    })
}

const BROWSER = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    cookie: "CONSENT=YES+cb; SOCS=CAI",
}

function parseFeed(xml) {
    return items(xml, "entry").map(e => {
        const id = tag(e, "yt:videoId")
        return { id, title: tag(e, "title"), date: new Date(tag(e, "published")).toISOString() }
    })
}

// YouTube often refuses its RSS feed from cloud servers (401/403/404), so try several sources.
async function youtube(channelId, filter, errors) {
    if (!channelId) return []
    const uploads = "UU" + channelId.slice(2)
    let vids = []
    const key = process.env.YOUTUBE_API_KEY
    if (key) {
        try {
            const r = await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=15&playlistId=" + uploads + "&key=" + key)
            if (!r.ok) throw new Error("API " + r.status)
            const j = await r.json()
            vids = (j.items || []).map(i => ({ id: i.snippet.resourceId.videoId, title: i.snippet.title, date: new Date(i.snippet.publishedAt).toISOString() }))
        } catch (e) { errors.push(String(e.message || e)) }
    }
    const urls = [
        "https://www.youtube.com/feeds/videos.xml?channel_id=" + channelId,
        "https://www.youtube.com/feeds/videos.xml?playlist_id=" + uploads,
    ]
    for (const u of urls) {
        if (vids.length) break
        try {
            const r = await fetch(u, { headers: BROWSER })
            if (!r.ok) throw new Error("YouTube feed " + r.status)
            vids = parseFeed(await r.text())
        } catch (e) { errors.push(String(e.message || e)) }
    }
    return vids
        .filter(v => v.id)
        .map(v => ({ ...v, url: "https://youtu.be/" + v.id, thumbnail: "https://i.ytimg.com/vi/" + v.id + "/maxresdefault.jpg" }))
        .filter(v => !filter || v.title.toLowerCase().includes(filter.toLowerCase()))
}

// A YouTube link written in the episode description wins over feed matching.
function linkedVideo(ep) {
    const m = (ep && (ep.rawDescription || ep.description) || "").match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|live\/|shorts\/|embed\/))([A-Za-z0-9_-]{11})/)
    if (!m) return null
    return { id: m[1], url: "https://youtu.be/" + m[1], thumbnail: "https://i.ytimg.com/vi/" + m[1] + "/maxresdefault.jpg", date: ep.date, title: ep.title }
}

const words = s => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2))
function score(a, b) {
    const A = words(a.title), B = words(b.title)
    const shared = [...A].filter(w => B.has(w)).length
    const days = Math.abs(new Date(a.date) - new Date(b.date)) / 864e5
    return shared * 2 - days
}

export default async function handler(req, res) {
    try {
        const errors = []
        const [eps, vids] = await Promise.all([
            podcast(process.env.SERMON_RSS_URL || "https://feeds.soundcloud.com/users/soundcloud:users:1073788417/sounds.rss"),
            youtube(process.env.YOUTUBE_CHANNEL_ID || "UCkmZjJp4M93UZUfy3z7Cisw", process.env.YOUTUBE_FILTER, errors),
        ])
        const ep = eps[0] || null
        let vid = vids[0] || null
        const linked = linkedVideo(ep)
        if (linked) vid = linked
        else if (ep && vids.length) {
            const near = vids.filter(v => Math.abs(new Date(v.date) - new Date(ep.date)) < 10 * 864e5)
            if (near.length) vid = near.sort((a, b) => score(ep, b) - score(ep, a))[0]
        }
        const body = {
            title: ep?.title || vid?.title || "",
            date: ep?.date || vid?.date || null,
            summary: ep?.summary || "",
            description: ep?.description || "",
            length: ep?.length || "",
            audioUrl: ep?.audioUrl || "",
            episodeUrl: ep?.episodeUrl || "",
            youtubeUrl: vid?.url || "",
            youtubeId: vid?.id || "",
            thumbnail: vid?.thumbnail || ep?.image || "",
            updated: new Date().toISOString(),
            ...(errors.length && !vid ? { youtubeError: errors.join("; ") } : {}),
        }
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=86400")
        res.status(200).json(body)
    } catch (e) {
        res.setHeader("Access-Control-Allow-Origin", "*")
        res.status(502).json({ error: String(e.message || e) })
    }
}
