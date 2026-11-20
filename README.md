# DecLoc Chat — Decentralized Local Chat

**DecLoc Chat** on 100% sõltumatu, null-sõltuvusega ja otsast lõpuni krüpteeritud (**E2EE**) grupivestlus (PWA), mis töötab kas otse **sinu enda vanas telefonis (Termux + SQLite)** või puhtalt **GitHub Pages** pealt — ilma build-sammuta ja lisakontodeta.

---

## Omadused

* **0 serverit, 0 lisakontot, 0 build-sammu** — ainult puhas HTML, CSS ja JavaScript.
* **Privaatsed parooliga jututoad** — loo tuba, jaga 1-kliki kutselinki (või suuliselt toa nime + parooli).
* **Täielik E2EE (PBKDF2 + HMAC + AES-256-GCM + BIP-340 Schnorr):**
  * Kõik sõnumid krüpteeritakse brauseris enne saatmist.
  * Kutselingi salajane osa asub URL-i `#`-fragmendis ega jõua kunagi GitHub Pagesi serverisse.
  * Sõnumid liiguvad läbi 3–5 avaliku Nostr-relay (või sinu enda relay), mis näevad ainult krüpteeritud pakette.
  * Igas toas tuletatakse kasutajale eraldi võtmepaar, nii et avalike relay'de pealt ei saa eri tubade kasutajaid kokku viia.
* **Grupivestlused, vastused, täielik emoji-valik (otsinguga ET/EN + GIF tugi), lugemiskinnitused („Nähtud“ koos kellaajaga), reaalajas kohalolijad ja „kirjutab…“ indikaator.**
* **Enda sõnumite kustutamine igalt poolt** — igaüks saab kustutada ainult *enda* saadetud sõnumid (üksikult või terve toa kaupa) nii oma seadmest, teiste osalejate seadmetest (krüpteeritud kustutuskäsk) kui ka Nostr-serveritest (**NIP-09 `kind: 5`**).
* **P2P WebRTC hääl- ja videokõned** otse brauserist koos paigutusvalikutega (**Kompaktne**, **Võrdne täisekraan**, **50/50 jagatud ekraan** ja **Fookus + paremal all pilt-pildis**).
* **PWA tugi** — mobiilis saab lisada avakuvale nagu päris äpi; kohalik ajalugu püsib `IndexedDB`-s.
* **Eesti ja inglise keel**, tume/hele teema, profiili varukoopia eksport/import.

---

## Kiire ülespanek — vali endale sobiv viis

### Variant A: Vana Androidi telefon (Termux) + Cloudflare Tunnel *(0 kontot, kõik andmed sinu telefonis!)*

Kui soovid, et **nii veebileht kui ka krüpteeritud Nostr-relay andmebaas (SQLite)** töötaksid otse sinu vanas telefonis 4G/5G CGNAT-i taga (ilma GitHub Pagesita ja ilma kontosid tegemata):

1. Paigalda vanasse telefoni [Termux](https://f-droid.org/packages/com.termux/) (F-Droidist) ja sisesta:
   ```bash
   pkg update && pkg install git nodejs cloudflared
   git clone <sinu-repo-url> decloc-chat && cd decloc-chat
   ./relay/start-termux.sh
   ```
2. Terminal prindib avaliku aadressi (nt `https://suvaline-nimi.trycloudflare.com`).
3. Ava see link brauseris ja jaga sõpradele — DecLoc Chat tunneb automaatselt ära, et server sisaldab oma relay'd (`/relay`), ja kasutab **ainult sinu telefoni serverit**!
4. Andmed salvestuvad `relay/data/decloc-relay.db` SQLite faili (säilivad üle telefoni taaskäivituste).

*(Püsiva oma alamdomeeni jaoks tasuta Cloudflare Named Tunneliga: `./relay/start-termux.sh --token <SINU_TUNNELI_TOKEN>`.)*

---

### Variant B: Ainult GitHub Pages *(0 serverit, 1 minut)*

1. **Forki** see repo oma GitHubi kontole (või lükka kood uude reposse).
2. Ava GitHubis **Settings → Pages**.
3. Vali **Source: Deploy from a branch** → branch `main` (kaust `/ (root)`) → **Save**.
4. Valmis! Sinu jututuba töötab mõne hetke pärast aadressil `https://<kasutajanimi>.github.io/<repo>/`.

### Oma alamdomeeni lisamine GitHub Pagesile (nt `chat.sinudomeen.ee`)

1. Lisa oma domeenipakkuja DNS-seadetesse `CNAME` kirje:
   ```text
   Tüüp: CNAME
   Nimi: chat
   Väärtus: <sinu-githubi-kasutajanimi>.github.io
   ```
2. Ava GitHubis **Settings → Pages → Custom domain**, sisesta `chat.sinudomeen.ee` ja salvesta.
3. Märgi linnuke **Enforce HTTPS** (GitHub väljastab automaatselt tasuta Let's Encrypt sertifikaadi).

---

## Kohalik testimine

Käivita projekti kaustas oma sisseehitatud server (veebileht + kohalik SQLite Nostr relay samal pordil):

```bash
node relay/server.mjs
```

Seejärel ava brauseris `http://localhost:7777` (võid avada teise akna inkognito-režiimis, et kahe kasutajana reaalajas vestlust testida!).

*(Või ainult staatilise lehe + avalike relay'de testimiseks: `python3 -m http.server 8080` → `http://localhost:8080`.)*

### Automaattestide käivitamine

```bash
node --test tests/*.test.mjs
```

---

## Kohandamine (`config.js`)

Failis `config.js` saad muuta:
* `APP_NAME` — rakenduse nimi
* `DEFAULT_LANG` — vaikimisi keel (`'et'` või `'en'`)
* `DEFAULT_RELAYS` — vaikimisi Nostr relay-serverite nimekiri (või oma privaatne relay)
* `SITE_PASSCODE_SHA256` — valikuline üldine ligipääsukood lehe esiaknale (SHA-256 räsi; `null` = välja lülitatud)
* `ICE_SERVERS` — STUN/TURN serverid P2P WebRTC kõnede jaoks

---

## Turvamudeli lühikirjeldus

1. **Toa võtmete tuletamine:** `PBKDF2-SHA256` (200 000 iteratsiooni) toa nimest ja salaparoolist → domeenieraldusega `HMAC-SHA256` toodab eraldi avaliku `channelId` (relay tag `#e`) ja salajase `AES-256-GCM` võtme.
2. **Sõnumi kaitse:** Iga sõnum saab värske juhusliku 96-bitise IV ja autentitud lisaandmed (`AAD = pubkey:channelId`), mis seovad krüptogrammi täpse saatja ja toaga.
3. **Allkirjastamine:** Kõik Nostr sündmused (`kind: 42` sõnumid, `kind: 20042` kohalolu/kirjutamine/WebRTC) allkirjastatakse ja kontrollitakse BIP-340 Schnorr allkirjaga.
4. **Piirang:** Avalikud Nostr-relay'd ei garanteeri sõnumite igavest säilimist, kuid aktiivsete seadmete kohalik `IndexedDB` hoiab avatud tubade ajaloo alles.

---

## Litsents

[MIT](./LICENSE)
