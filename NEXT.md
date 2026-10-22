# Norrsken – överlämning (version 1.8.5, 22 okt 2026)

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
- Otestat: AirPlay-knappen (1.8.5), tv:n (Titan OS) efter 1.8.x, 4K på iMac efter "HEVC orört först" (1.8.1).

## Användarens krav
- Felfritt på tv:n (Philips, Titan OS = bara HTML5-appar). 4K och flerkanalsljud ska fungera. Mobil och iMac (5K) också.
- Alternativ som diskuterats: Android/Google TV-dosa med egen privat app (inbyggd spelare, inget omkodningssteg), "Spela i IINA" på Mac.
- Pusha till main först när användaren sagt ja. Svara kort på svenska. Två domare vid granskningsrundor, bara ändrade skärmar.

## Kvar från domarrunda 4 (betyg 8/7/8 båda)
1. Catch-up: när arkivet tar slut i ett pågående program – hämta igen från cur(), live bara nära "nu" (player.js onEnded).
2. Player.deactivate: alltid reqId = {} och suspended = true; watchdog/startSource/cuCatch avbryter när suspended.
3. Versionsval: reserv till item.id om item.vid inte startar; sortera versioner efter kvalitet i NS.bestVersion.
4. Läsbarhet tv: fokuserat avsnitt vit titel, flytta "Håll OK"-ledtråden, mörkare toning bakom liveinfo.
5. Mobil: täckande sidhuvud i kanaltablån, centrera play-ikon på avsnitt, säsongsväljaren under sidhuvudet.
6. Påminnelser: slå ihop lokal lista med serverns vid synk (main.js).
7. Håll OK: tåla fjärrkontroller som skickar upprepade tryck/släpp.
8. Småsaker: gräns 36 h i guiden (move), position i catch-up, "I går", sökrutans text, PIN-etikett i inställningarna.

## Kod
- Källa: norrsken/app (server.js, lib/, public/). Tester: `node --test test/*.test.js` i källrepot (25 st, mock-leverantör i test/).
