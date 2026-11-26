# Betegbehívó

Betegbehívó rendszer magánrendelőnek: váró-kijelző gonggal és QR-kóddal, orvosi felület, recepció, valamint mobilos önbejelentkezés a betegeknek.

- `index.html` – személyzeti felület (PIN-kóddal): `#kijelzo`, `#orvos-1`, `#recepcio`, `#beallitasok`
- `beteg.html` – betegoldal, a QR-kódból nyílik
- `api/` – Vercel Functions, Upstash Redis adattárolással (`UPSTASH_REDIS_REST_URL`/`_TOKEN` vagy `KV_REST_API_URL`/`_TOKEN`)

A PIN-kódot az első indításkor a felületen kell beállítani. A napi sor 36 óra után magától törlődik.
