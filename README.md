# WikiRace

A party game for desktop browsers. Everyone starts on the same Wikipedia article and races to reach another one, using only the links in the text.

**Play it:** https://haydenschmitty.github.io/WikiRace/

## How a game works

1. One person creates a room and shares the four-letter code (or the invite link).
2. Everyone else joins from their own computer. Up to 12 players.
3. Each round picks a random start article and a random target from a pool of about 1,550 well-known articles.
4. Click links until you land on the target. An overlay shows the timer and every player's click count as it happens.
5. After each round you see everyone's clicks, time, score and the path they took.
6. After the last round there is an overall winner, plus awards for fastest and fewest clicks.

### Scoring

```
score = clicks + factor × seconds
```

Lowest score wins. The host sets the factor ("points per second", 0.1 by default), the number of rounds and the time limit. A player who has not arrived when the time limit runs out is scored at the full time limit plus 10 points.

## How it is built

WikiRace is a static site: plain HTML, CSS and JavaScript with no build step and no server of its own.

- **Rooms** use [PeerJS](https://peerjs.com/) (WebRTC). The host's tab holds the game state and sends it to every guest. PeerJS's free public broker is only used to introduce the browsers to each other.
- **Articles** come from Wikipedia's public API (`action=parse`) and are rendered inside the page, so every link click can be counted. Only links to other articles are clickable.
- **The pool** of start and target articles lives in [`pool.js`](pool.js). Add any exact English Wikipedia article title to it (not a redirect or a disambiguation page).

| File | What it holds |
| --- | --- |
| `index.html` | The screens |
| `styles.css` | All styling |
| `app.js` | Rooms, game rules, article rendering, results |
| `pool.js` | The article pool |

## Run it yourself

Serve the folder with any static file server and open it in a browser, for example:

```bash
npx serve .
```

To host your own copy, fork the repo and turn on GitHub Pages for the `main` branch.

## Good to know

- If the host closes or reloads their tab, the room ends.
- Connections go directly between browsers. Some strict office or school networks block that.
- Wikipedia limits bursts of requests from one network. The game waits and retries, but a big group on the same Wi-Fi may see slower article loads.
- Built for desktop. It works on a phone, but the articles are easier to read on a big screen.

## Credits and license

Code is released under the [MIT License](LICENSE).

Article text and images are loaded live from [Wikipedia](https://www.wikipedia.org/) and are available under the [Creative Commons Attribution-ShareAlike 4.0 License](https://creativecommons.org/licenses/by-sa/4.0/). WikiRace is not affiliated with Wikipedia or the Wikimedia Foundation.

Fonts are [Fredoka](https://fonts.google.com/specimen/Fredoka) and [Lilita One](https://fonts.google.com/specimen/Lilita+One), both under the SIL Open Font License.
