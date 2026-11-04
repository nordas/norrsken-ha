# Lärdomar från förbättringsloopen (bekräftade av Oskar 2026-10-27)

1. En spärr ska täcka ALLA vägar som öppnar en leverantörsanslutning (stream, rx, px, pause, speedtest, prepare, probe, matchinspelning) och testas från varje ingång. Ny ström avslutar den gamla.
2. När en ny åtgärd kopplas till ett befintligt anrop: kartlägg alla klientanrop till det, även förberedelse och bakgrund (t.ex. AirPlay-förberedelsen).
3. Hemligheter maskas där data lämnar processen (svar, loggar, felsträngar från bibliotek och ffmpeg), inte bara där man senast ändrade.
4. Tester ska asserta ovillkorligt, aldrig bara när tillståndet råkar uppstå.
5. Tidsregler (t.ex. OSD släcks efter 5 s) verifieras över tid, inte bara direkt efter öppning.
6. Testa i samma miljö/mediafråga som den riktiga enheten och rapportera när det inte går.
7. En flagga som ger ett "bara läsa"-läge hoppar bara över sidoeffekter; alla spärrar och behörighetskontroller ligger före flaggan.
8. Funktion först. Main-push och nya lärdomar kräver Oskars uttryckliga ja.

## Bekräftade av Oskar 2026-11-04

9. En pågående inspelnings spellista markeras som slut först när hela händelsen är över, inte när leverantören tappar strömmen.
10. Ett skydd som bara kontrolleras vid start måste också ge vika för nya signaler, och automatiska omstarter behöver växande väntetid (backoff).
11. Varje ny sida eller adress får samma PIN-krav, barnprofilskontroll och escaping, och testas från klientens sida.
12. Varje sorts signerad länk har sin egen härledda nyckel.
