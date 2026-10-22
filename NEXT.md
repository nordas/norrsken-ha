# Nästa steg (efter domarrunda 4, version 1.8.0)

Betyg runda 4: Domare A 8/7/8, Domare B 8/7/8 (användarvänlighet/design/funktioner).

Kvar att göra, i ordning:
1. Catch-up: när arkivströmmen tar slut i ett program som fortfarande sänds – hämta igen från aktuell position (play(item, cur())) och gå bara till live nära "nu" (player.js onEnded).
2. Player.deactivate: sätt alltid reqId = {} och suspended = true; låt watchdog/startSource/cuCatch avbryta när suspended (ingen ström bakom guiden).
3. Versionsval: reserv till originalet (item.id) om vald version (item.vid) inte startar; sortera versioner uttryckligen efter kvalitet i NS.bestVersion.
4. Läsbarhet tv: fokuserat avsnitt med full vit titel, flytta "Håll OK"-ledtråden, mörkare toning bakom liveinfo, nedersta radens titlar tonas inte bort.
5. Mobil: helt täckande sidhuvud i kanaltablån, centrera play-ikon på avsnitt, säsongsväljaren under sidhuvudet, kontroller synliga i stående spelare.
6. Påminnelser: slå ihop lokal lista med serverns vid synk i stället för att skriva över (main.js).
7. Håll OK: tåla fjärrkontroller som skickar upprepade tryck/släpp; OK direkt i spelaren.
8. Småsaker: gräns 36 h framåt i guiden (move), spara position i catch-up, barnlås-läge på servern per enhet, "I går" med litet g, sökrutans text "Titel, kanal eller skådespelare", etikett "PIN" vid låset och neutral färg på tipset i inställningarna.

Arbetssätt för domarrundor: två domare, bara ändrade skärmar.
