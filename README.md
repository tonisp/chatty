# Kaja — Serverita krüpteeritud grupivestlus

**Kaja** on 100% staatiline, null-sõltuvusega ja otsast lõpuni krüpteeritud (**E2EE**) grupivestlus (PWA), mis töötab otse **GitHub Pages** pealt — ilma oma serverita, andmebaasita, build-sammuta ja lisakontodeta.

---

## Omadused

* **0 serverit, 0 lisakontot, 0 build-sammu** — ainult puhas HTML, CSS ja JavaScript.
* **Privaatsed parooliga jututoad** — loo tuba, jaga 1-kliki kutselinki (või suuliselt toa nime + parooli).
* **Täielik E2EE (PBKDF2 + HMAC + AES-256-GCM + BIP-340 Schnorr):**
  * Kõik sõnumid krüpteeritakse brauseris enne saatmist.
  * Kutselingi salajane osa asub URL-i `#`-fragmendis ega jõua kunagi GitHub Pagesi serverisse.
  * Sõnumid liiguvad läbi 3–5 avaliku Nostr-relay (või sinu enda relay), mis näevad ainult krüpteeritud pakette.
  * Igas toas tuletatakse kasutajale eraldi võtmepaar, nii et avalike relay'de pealt ei saa eri tubade kasutajaid kokku viia.
* **Grupivestlused, vastused, reaktsioonid, reaalajas kohalolijad ja „kirjutab…“ indikaator.**
* **P2P WebRTC hääl- ja videokõned** otse brauserist (kasutavad sama krüpteeritud kanalit ühenduse loomiseks).
* **PWA tugi** — mobiilis saab lisada avakuvale nagu päris äpi; kohalik ajalugu püsib `IndexedDB`-s.
* **Eesti ja inglise keel**, tume/hele teema, profiili varukoopia eksport/import.

---

## Kiire ülespanek GitHub Pagesisse (1 minut)

1. **Forki** see repo oma GitHubi kontole (või lükka kood uude reposse).
2. Ava GitHubis **Settings → Pages**.
3. Vali **Source: Deploy from a branch** → branch `main` (kaust `/ (root)`) → **Save**.
4. Valmis! Sinu jututuba töötab mõne hetke pärast aadressil `https://<kasutajanimi>.github.io/<repo>/`.

### Oma alamdomeeni lisamine (nt `chat.sinudomeen.ee`)

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

Kuna krüpteerimine (`Web Crypto API`) vajab `https://` või `http://localhost` aadressi, käivita projekti kaustas lihtne kohalik veebiserver:

```bash
python3 -m http.server 8080
```

Seejärel ava brauseris `http://localhost:8080` (võid avada teise akna inkognito-režiimis, et kahe kasutajana reaalajas vestlust testida!).

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
