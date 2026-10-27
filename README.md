# Saint John's sermon feed

One serverless function: `GET /api/latest-sermon` returns the newest sermon as JSON,
combining the SoundCloud RSS feed (title, summary, audio, length) with the
YouTube channel feed (video link and thumbnail). The Framer site reads it.

## Deploy (one time, about 5 minutes)
1. Push this folder to a GitHub repo (or upload it at vercel.com/new).
2. Import it in Vercel. No build settings needed.
3. No settings needed: the SoundCloud feed and YouTube channel are built in.
   Optional: add `YOUTUBE_FILTER` (e.g. `Sermon`) if the channel also posts full services,
   so only sermon videos are matched.
4. Deploy, then open `https://<your-project>.vercel.app/api/latest-sermon` to check it.
5. In Framer, open the code file SermonFeed.tsx and paste that URL into
   `export const FEED_URL = ""` near the top. The sermon cards on Home and
   Worship then fill themselves. Leave it empty to keep using the Sermons CMS.

Responses are cached for 15 minutes at the edge, so new sermons show up quickly
without hitting YouTube or Spotify on every page view.
