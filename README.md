# Saint John's sermon feed

One serverless function: `GET /api/latest-sermon` returns the newest video in the
YouTube **Sermons** playlist as JSON. The Framer site's sermon cards read it.

It uses YouTube's public pages only (no API key, no SoundCloud):
1. The playlist's RSS feed, when YouTube allows it from Vercel's servers.
2. Otherwise the playlist page itself (the playlist is ordered newest first).
3. The video's page for the description: preacher's role, "Preached <date>",
   the "Gospel:" line under READINGS, and the line under QUOTE.

The card's title, reading and preacher come from the video title,
e.g. `Proper 21, Year A (Matthew 21:23–32) | The Rev. Dr. Paul Wheatley | Saint John's Tulsa`.
Keep using that title format and description template and the card fills itself.

Optional: `SERMONS_PLAYLIST_ID` overrides the playlist.
Responses are cached for 15 minutes.

## Quote
Add this to the video description and the card shows it (straight quotes become curly):

    QUOTE
    "Jesus' authority is given, not taken."
