# Norrsken – IPTV-app för Philips-tv (Titan OS)

En egen tv-app i samma stil som de stora streamingtjänsterna (toppmeny, stor billboard, kort som expanderar vid fokus, färgglöd från bilden, Topp 10): profiler, "Fortsätt titta", Min lista, live-tv med tv-guide, filmer, serier med säsonger och automatiskt nästa avsnitt. Styrs helt med fjärrkontrollen.

Appen består av två delar:

- **En liten server** som körs på en dator i hemmet som alltid är på (Raspberry Pi, NAS, gammal laptop, hemserver). Den pratar med din IPTV-leverantör, håller lösenordet och skickar strömmarna vidare till tv:n.
- **Själva tv-appen**, en webbapp som tv:n öppnar från servern.

Inga tillägg eller npm-paket behövs, bara Node.js 18 eller senare (eller Docker).

## Snabbaste vägen: som tillägg i Home Assistant

Kör du Home Assistant OS (även i VirtualBox) kan appen köras som ett lokalt tillägg och startar då automatiskt med Home Assistant.

1. Kör `sh homeassistant/build-addon.sh` (eller använd den färdiga mappen `homeassistant/norrsken`).
2. Kopiera mappen `norrsken` till `/addons` på Home Assistant, t.ex. med tillägget *Samba share* eller *Studio Code Server*.
3. I Home Assistant: **Inställningar → Tillägg → Tilläggsbutik → ⋮ → Sök efter uppdateringar**. *Norrsken IPTV* syns under *Lokala tillägg*.
4. Installera, slå på *Starta vid uppstart* och starta.
5. Öppna `http://<home-assistant-ip>:8787/setup` i mobilen.

Ge Home Assistant en fast IP-adress i routern. I VirtualBox måste nätverkskortet vara *Bryggat* (bridged) för att tv:n ska nå det.

## 1. Starta servern (utan Home Assistant)

**Med Docker (rekommenderas, inkluderar ffmpeg):**

```sh
docker compose up -d --build
```

**Med Node.js:**

```sh
node server.js
```

Servern skriver ut sina adresser, till exempel:

```
TV-appen:      http://192.168.1.50:8787/
Inställningar: http://192.168.1.50:8787/setup
```

Ge datorn en fast IP-adress i routern, annars kan adressen ändras.

## 2. Ställ in leverantören i mobilen

Öppna `http://<serverns-ip>:8787/setup` i mobilen (eller skanna QR-koden som tv-appen visar första gången).

1. Välj **Xtream Codes** och fyll i server, användarnamn och lösenord. Har du bara en M3U-länk av typen `get.php?username=…&password=…` känner sidan igen den och erbjuder Xtream i stället – det ger affischer, beskrivningar och avsnittslistor.
2. Tryck **Testa anslutningen**.
3. Lägg upp profiler. Barnprofiler ser bara barnkategorier och aldrig vuxeninnehåll.
4. Tryck **Spara och hämta utbudet**.
5. Bocka ur kategorier du inte vill se under **Kategorier** (t.ex. alla länder utom SE och NORDIC). Filtret gör det snabbt: skriv `SE`, tryck *Visa alla som matchar*, osv.

## 3. Öppna appen på Philips-tv:n (Titan OS)

Titan OS har ingen öppen appbutik, men utvecklarverktyget **DevView** kan starta valfri webbapp:

1. Skapa konto och logga in på **Titan OS Partner Portal** på datorn.
2. Under **DevView**: begär åtkomst om det behövs och lägg till en app i din *Sandbox* med adressen `http://<serverns-ip>:8787/`.
3. På tv:n: öppna appen **DevView** (finns under *Apps*, i Lifestyle-raden; på 2020–2022-modeller i *App Gallery*). Lägg gärna till den bland favoriterna.
4. Under **Device Management** i portalen: para tv:n med koden som DevView visar.
5. Starta appen från DevView.

**Om portalen inte godtar en lokal adress:** använd `homeassistant/tv-start.html`. Ändra IP-adressen överst i filen, lägg den på en publik https-adress (t.ex. GitHub Pages) och ange den adressen i portalen. Sidan skickar tv:n vidare till servern hemma och visar ett tydligt fel om servern inte är igång.

Appen fungerar också i vanliga webbläsare – i datorn, på surfplattan och på andra smart-tv:ar.

## Fjärrkontrollen

| Knapp | Bläddra | Live-tv | Film/serie |
|---|---|---|---|
| Pilar | Flytta | ▲▼ byt kanal, ◀ kanallista | ◀▶ spola (håll in = snabbare), ▼ knappar |
| OK | Öppna | Kanallista | Paus/spela |
| Back | Tillbaka / menyn | Tillbaka | Tillbaka (positionen sparas) |
| 0–9 | – | Välj kanal med nummer | – |
| P+/P− | – | Byt kanal | – |
| Play/Paus, ⏩ ⏪ | – | Paus | Paus, spola |
| Gul | Sök | – | – |

I kanallistan byter ◀▶ kategori.

## Bra att veta

- **Förhandsvisningar:** billboarden, kortet du står på och detaljsidan börjar spela efter ett par sekunder, som i Netflix. Filmer och serier spelar ungefär 45 sekunder en bit in i filmen, kanaler spelar live. Välj *med ljud*, *utan ljud* eller *av* i inställningarna. En förhandsvisning använder en av kontots samtidiga strömmar medan den spelar och stängs innan den riktiga uppspelningen startar.

- **MKV-filer, ljudspår och undertexter** kräver ffmpeg på servern (ingår i Docker-avbildningen). Då kan du välja svenska undertexter och ljudspråk under *Ljud och undertexter* i spelaren, och appen minns valet till nästa gång.
- **Tv-guiden** hämtas från leverantören (XMLTV). Har leverantören ingen guide kan du ange en egen länk under *Avancerat*.
- **Utbudet uppdateras** automatiskt två gånger per dygn, eller direkt via *Inställningar → Uppdatera utbudet* på tv:n.
- **Hackar en kanal?** Byt format för live-tv till MPEG-TS i inställningarna. Appen provar redan det andra formatet automatiskt när det första inte fungerar.
- **Inget ljud i filmer?** Välj *Gör alltid om till AAC* under *Avancerat*.
- **Lås inställningssidan** med miljövariabeln `SETUP_PIN=1234`.
- All data (inställningar, listor, historik) ligger i mappen `data/`.

Appen spelar bara upp det din leverantör ger dig. Se till att tjänsten du använder har rätt att sända innehållet.

## För utvecklare

```sh
sh test/make-media.sh          # skapar små testklipp (kräver ffmpeg)
npm test                       # servertester mot en låtsasleverantör
node test/mock-provider.js     # låtsasleverantör på :9911 (användare demo, lösenord "p@ss word")
```

Struktur: `server.js` (HTTP, API), `lib/` (leverantör, EPG, proxy, ffmpeg, QR), `public/` (tv-appen och inställningssidan). Tv-appen är skriven i ES2017 utan ramverk för att fungera i äldre tv-webbläsare. Gränssnittet är ritat för 1920×1080 och skalar efter skärmen.

Tredjepartskod: [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0), [mpegts.js](https://github.com/xqq/mpegts.js) (Apache-2.0), typsnittet Inter (OFL).
