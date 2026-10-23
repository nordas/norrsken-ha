# Norrsken – överlämning (version 1.10.0 på dev, 23 okt 2026)

## Nytt i 1.9.0–1.10.0 (dev, inte på main än)
- 1.9.0: muskontroller, "Föreslaget för dig", gillar/inte för mig.
- Ljudspårsbyte i alla lägen: hls.js-renditioner, skärmens egna spår (video.audioTracks) när filen spelas direkt, annars servern (a=N). Under AirPlay byts spåret i Safaris egen spelare. Testat i Chromium med och utan inbyggda spår.
- Undertexter: svenska förval per profil (NS.pref sub, standard sv). Svenskt tal → bara tvingade. Byter man till utländskt ljud slås svenska på, tillbaka till svenska → av igen. Undertexten flyttas upp när knapparna syns.
- Favoritlag (standard Luleå Hockey) överst på startsidan när tv-guiden visar match nu eller inom en timme (lib/sport.js), OK byter kanal. Väljs i inställningarna.
- Streamingtjänster (Netflix, Max, Disney+, Prime Video) via TMDB-nyckel i /setup: sök, "Finns på …", "Öppna i appen", förslagsrad (lib/services.js). Kräver nyckel.
- Paus på live-tv: kanaler med arkiv fortsätter från arkivet; övriga spelas in till disk på servern (lib/tsbuf.js, högst 30 min–3 h, slutar vid <1,5 GB ledigt). Pausen överlever att tv-guiden öppnas. Inställning i /setup.
- Otestat på riktig tv/iPhone: allt ovan. Kolla särskilt paus på riktig leverantör (H.264/TS) och ljudspår på Titan OS.
- Domarrundor: användaren vill inte ha dem tills vidare.

## Läge just nu
- Home Assistant (VM i VMware Fusion på iMacen, 192.168.85.51) slutade svara efter uppdatering till 1.8.5. Kolla först:
  1. Svarar HA efter några minuter? Vad står i VM-konsolen?
  2. Om HA blir snabbt när Norrsken stoppas: troligen minne. Misstänkt: EPG sparas 3 dygn bakåt sedan 1.8.0 (lib/epg.js `from = now - 3 * 86400e3`) → sänk till 1 dygn / bara kanaler med arkiv. Kolla VM:ens RAM.
  3. Andra kandidater: bakgrundsindexering av skådespelare (provider.js startPeopleIndex), ffmpeg-sessioner.

## Buffring – vad mätningarna visat (loggraderna [remux] och [spelare …])
- Servern packar om 20–50× realtid (h264), 4K HEVC ~1,5–3×. Första bild 1–6 s.
- iPhone (hls.js via ManagedMediaSource) får 27–65 Mbit/s och buffrar bara vid start/spolning.
- Väntan = omstart av konvertering vid spolning (1.8.5: hopp inom konverterat område utan omstart) + leverantören svarar trögt (0,07–0,2×) efter stora hopp.
- Safari med inbyggd HLS-spelare blev sämre (backat i 1.8.4).
- AirPlay-knappen syntes inte i 1.8.5 (iPhone saknar elementhelskärm; hls.js rensar <source>). Knappen syns i 1.8.6 men gav bara ljud (hls.js/MMS). 1.8.7 byter till Safaris egna HLS-spelare vid AirPlay och tillbaka efteråt – otestat.
- HA hängde vid uppdatering till 1.8.5 (Supervisor/DNS-timeouts ~18:17). 1.8.5 ändrade bara frontend; tillägget låg på 6 % RAM efteråt → troligen lokalt bygge + omstart, inte en läcka.
- Otestat:, tv:n (Titan OS) efter 1.8.x, 4K på iMac efter "HEVC orört först" (1.8.1).

## Användarens krav
- Felfritt på tv:n (Philips, Titan OS = bara HTML5-appar). 4K och flerkanalsljud ska fungera. Mobil och iMac (5K) också.
- Alternativ som diskuterats: Android/Google TV-dosa med egen privat app (inbyggd spelare, inget omkodningssteg), "Spela i IINA" på Mac.
- Pusha till main först när användaren sagt ja. Svara kort på svenska. Inga domarrundor (användarens önskan 23 okt).

## Kvar från domarrunda 4 (betyg 8/7/8 båda)
1. ~~Catch-up vid arkivslut~~ – klart i 1.8.6 (player.js cuEnded).
2. ~~Player.deactivate~~ – klart i 1.8.6.
3. Versionsval: reserv till item.id om item.vid inte startar; sortera versioner efter kvalitet i NS.bestVersion.
4. Läsbarhet tv: fokuserat avsnitt vit titel, flytta "Håll OK"-ledtråden, mörkare toning bakom liveinfo.
5. Mobil: täckande sidhuvud i kanaltablån, centrera play-ikon på avsnitt, säsongsväljaren under sidhuvudet.
6. Påminnelser: slå ihop lokal lista med serverns vid synk (main.js).
7. Håll OK: tåla fjärrkontroller som skickar upprepade tryck/släpp.
8. Småsaker: gräns 36 h i guiden (move), position i catch-up, "I går", sökrutans text, PIN-etikett i inställningarna.

## Kod
- Källa: norrsken/app (server.js, lib/, public/). Tester och mock-leverantör: dev/test (kopiera till app-mappen som test/, skapa testmedia med make-media.sh, kör `node --test test/*.test.js`, 40 st).
