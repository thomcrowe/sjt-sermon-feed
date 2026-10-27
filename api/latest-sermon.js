// GET /api/latest-sermon
// Returns the newest video in Saint John's YouTube "Sermons" playlist as JSON.
// Uses YouTube's public pages and feeds only: no API key, no SoundCloud.
//
// Optional environment variables (Vercel → Project → Settings → Environment Variables):
//   SERMONS_PLAYLIST_ID  defaults to the channel's "Sermons" playlist

const PLAYLIST = process.env.SERMONS_PLAYLIST_ID || "PLC1HXC3oUsWtBcIErJAvwbwyartlxk9xY"

const HEADERS = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "accept-language": "en-US,en;q=0.9",
    cookie: "CONSENT=YES+cb; SOCS=CAI",
}

function decode(s = "") {
    return s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
        .replace(/&amp;/g, "&")
        .trim()
}
const tag = (xml, name) => { const m = xml.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i")); return m ? decode(m[1]) : "" }
const jsonString = s => { try { return JSON.parse('"' + s + '"') } catch { return s } }

async function get(url) {
    const r = await fetch(url, { headers: HEADERS })
    if (!r.ok) throw new Error(url.split("?")[0].replace("https://www.youtube.com", "") + " " + r.status)
    return r.text()
}

// 1) The playlist's public RSS feed (newest by publish date).
async function fromFeed() {
    const xml = await get("https://www.youtube.com/feeds/videos.xml?playlist_id=" + PLAYLIST)
    const vids = xml.split(/<entry[\s>]/i).slice(1).map(e => ({
        id: tag(e, "yt:videoId"),
        title: tag(e, "title"),
        date: new Date(tag(e, "published")).toISOString(),
        description: tag(e, "media:description"),
    })).filter(v => v.id)
    vids.sort((a, b) => new Date(b.date) - new Date(a.date))
    return vids[0]
}

// 2) The playlist page itself (the playlist is ordered newest first).
async function fromPage() {
    const html = await get("https://www.youtube.com/playlist?list=" + PLAYLIST)
    const id = (html.match(/"watchEndpoint":\{"videoId":"([\w-]{11})"/) || html.match(/"videoId":"([\w-]{11})"/) || [])[1]
    if (!id) throw new Error("no videos found in playlist page")
    const at = html.indexOf(id)
    const after = html.slice(at)
    const t = after.match(/"lockupMetadataViewModel":\{"title":\{"content":"((?:[^"\\]|\\.)*)"/) || after.match(/"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/)
    return { id, title: t ? jsonString(t[1]) : "" }
}

// Extra detail from the watch page: description, length, publish date. Optional.
async function details(id) {
    try {
        const html = await get("https://www.youtube.com/watch?v=" + id)
        const d = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/) || html.match(/"attributedDescription":\{"content":"((?:[^"\\]|\\.)*)"/)
        const len = html.match(/"lengthSeconds":"(\d+)"/)
        const pub = html.match(/"publishDate":"([^"]+)"/) || html.match(/"publishDate":\{"simpleText":"([^"]+)"/) || html.match(/itemprop="datePublished" content="([^"]+)"/)
        return {
            description: d ? jsonString(d[1]) : "",
            seconds: len ? +len[1] : 0,
            date: pub ? new Date(pub[1]).toISOString() : null,
        }
    } catch {
        return {}
    }
}

// "Proper 21, Year A (Matthew 21:23–32) | The Rev. Dr. Paul Wheatley | Saint John's Tulsa"
function parseTitle(full) {
    const parts = full.split("|").map(s => s.trim()).filter(Boolean)
    let title = parts[0] || full
    let reading = ""
    const m = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/)
    if (m) { title = m[1]; reading = m[2] }
    const preacher = parts.length > 2 ? parts[1] : (parts[1] && !/saint john/i.test(parts[1]) ? parts[1] : "")
    if (reading && /^(Matthew|Mark|Luke|John)\b/.test(reading)) reading = "Gospel: " + reading
    return { title, reading, preacher }
}

// "The Rev. Dr. Paul Wheatley, Assistant Professor of New Testament at Nashotah House Theological Seminary, preaches at ..."
function roleFrom(description, preacher) {
    const first = (description.split("\n")[0] || "").trim()
    const m = first.match(/^(.+?),\s*(.+?),\s*preache[sd]\b/i)
    if (m && (!preacher || m[1].trim() === preacher)) return m[2].trim()
    return ""
}
function preachedDate(description) {
    const m = description.match(/Preached\s+([A-Z][a-z]+ \d{1,2},? \d{4})/)
    const d = m ? new Date(m[1]) : null
    return d && !isNaN(d) ? d.toISOString() : null
}
function readingFrom(description) {
    const m = description.match(/^\s*(Gospel:\s*[^\n]+)/m)
    return m ? m[1].trim() : ""
}

function summaryFrom(description) {
    const paras = description.split(/\n\s*\n|\n/).map(s => s.trim())
        .filter(s => s.length > 40 && !/^https?:\/\//.test(s) && !/subscribe|sjtulsa\.org|follow us/i.test(s))
    return paras[0] || ""
}

export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*")
    const errors = []
    let v = null
    try { v = await fromFeed() } catch (e) { errors.push(String(e.message || e)) }
    if (!v) { try { v = await fromPage() } catch (e) { errors.push(String(e.message || e)) } }
    if (!v) {
        res.status(502).json({ error: errors.join("; ") })
        return
    }
    const more = await details(v.id)
    const description = v.description || more.description || ""
    const parsed = parseTitle(v.title)
    const title = parsed.title, preacher = parsed.preacher
    const reading = readingFrom(description) || parsed.reading
    const body = {
        title,
        preacher,
        role: roleFrom(description, preacher),
        reading,
        fullTitle: v.title,
        date: preachedDate(description) || v.date || more.date || null,
        summary: summaryFrom(description),
        description,
        length: more.seconds ? Math.round(more.seconds / 60) + " min" : "",
        youtubeUrl: "https://youtu.be/" + v.id,
        youtubeId: v.id,
        thumbnail: "https://i.ytimg.com/vi/" + v.id + "/maxresdefault.jpg",
        updated: new Date().toISOString(),
        ...(errors.length ? { notes: errors.join("; ") } : {}),
    }
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=86400")
    res.status(200).json(body)
}
