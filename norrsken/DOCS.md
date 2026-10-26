# Norrsken IPTV

## Adresser

- **Tv-appen:** http://192.168.85.51:8787/
- **Inställningar (mobilen):** http://192.168.85.51:8787/setup

Adresserna gäller så länge Home Assistant har IP-adressen 192.168.85.51. Ge den gärna en fast adress i routern.

## Kom igång

1. Öppna inställningarna i mobilen och fyll i uppgifterna från din IPTV-leverantör (Xtream Codes eller M3U-länk). Tryck *Testa anslutningen* och sedan *Spara och hämta utbudet*.
2. Bocka ur kategorier du inte vill se och lägg upp profiler.
3. Lägg in tv-appens adress i Titan OS Partner Portal (DevView → Sandbox), para tv:n med koden i DevView-appen och starta Norrsken.

## Om något inte fungerar

- **Buffrar eller hackar:** välj *Uppspelning: Direkt från leverantören* i inställningarna. Byt format för live-tv till MPEG-TS om kanaler fortfarande hackar.
- **4K:** filmer i HEVC/H.264 spelas i full 4K utan konvertering. Bara format som tv:n inte kan visa konverteras, i 4K om inget annat väljs under *Bild som måste konverteras*.
- **Surroundljud:** Dolby Digital och Dolby Digital Plus spelas orört. DTS, DTS-HD MA och TrueHD packas om förlustfritt till FLAC med alla kanaler (upp till 7.1), som tv:n skickar som flerkanaligt PCM till soundbaren via eARC. Ändra under *Ljud i filmer och serier*.
- **Inget ljud i filmer:** välj *Alltid stereo (AAC)* under Avancerat.
- **Sidan öppnas inte:** kontrollera att tillägget kör och att du är på hemmanätverket.

Inställningar, listor och historik sparas i tilläggets data och följer med i Home Assistants säkerhetskopior.

## PIN-kod för inställningarna

Sidan `/setup` innehåller ditt konto hos leverantören och kräver därför alltid en PIN-kod.

- Vid första starten skapas en sexsiffrig PIN-kod. Den står i tilläggets **Logg** (raden `PIN för /setup`).
- Vill du välja en egen: skriv den under tilläggets **Konfiguration → setup_pin** och starta om tillägget.
- Fem fel i rad ger en väntetid som fördubblas för varje nytt fel (upp till 15 minuter).

## Kryptering av leverantörens uppgifter

Lägg raden som visas under Leverantör på `/setup` (`norrsken_nyckel: …`) i Home Assistants `secrets.yaml` och starta om tillägget. Då sparas användarnamn och lösenord krypterade.
