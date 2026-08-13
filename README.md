# Solaris Capacity Calculator

Works out how many SunnyApps fit in one server or a cluster, and what the resulting
php-fpm, PostgreSQL and PgBouncer settings should be.

Static page. No build step, no server, no dependencies.

```
index.html         markup
assets/theme.js    Solaris palette for the Tailwind CDN build
assets/app.css     the handful of styles Tailwind does not cover
assets/app.js      the whole engine and UI
calculator.test.js 111 tests, Node only — do not deploy
```

## Run it

Open `index.html` in a browser. That is all.

Tailwind and Poppins load from CDN, so the page needs internet the first time.

## Test the engine

```bash
node calculator.test.js
```

The tests load `assets/app.js` behind a DOM stub, so there is no second copy of the maths
to keep in sync. Change a constant in the page and the tests immediately check it.

## Deploying

Any static host works — GitHub Pages, Cloudflare Pages, Netlify, or plain shared hosting.
Upload `index.html` and `assets/`. Leave `calculator.test.js` behind.

GitHub Pages on the free plan only serves **public** repositories. This page shows internal
capacity and pricing assumptions, so if that matters, use Cloudflare Pages with Access, or
shared hosting behind basic auth.

## Where the numbers come from

Every assumption lives in the `K` object near the top of the `<script>` block in `index.html`.
Change one value there and the whole model follows.

Memory figures were measured on the Solaris dev server using PSS (`/proc/*/smaps_rollup`),
not RSS — RSS double-counts shared pages and would inflate any total.

Two assumptions are still estimates and should be replaced once there is production data:

| Assumption | Current | How to measure it |
|---|---|---|
| Average response time | 0.30 s | Enable the php-fpm access log with `%{mili}d`, read the percentiles after a day |
| Seconds per `wa-ai` job | 18 s | Time the job in the queue worker |

The mobile figures (`mobileRpm`, `mobileResp`, `mobileRowsDay`) are estimates too — measurable
from the same php-fpm log by filtering `/api/*`.

File storage is charged at the quota sold (1 GB per user), not at measured usage.
