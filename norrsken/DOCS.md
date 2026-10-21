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
- **Surroundljud:** Dolby Digital och Dolby Digital Plus spelas orört. DTS, DTS-HD och TrueHD görs om till Dolby Digital Plus 5.1 med alla kanaler, som tv:n skickar vidare till soundbaren via eARC. Ändra under *Ljud i filmer och serier*.
- **Inget ljud i filmer:** välj *Alltid stereo (AAC)* under Avancerat.
- **Sidan öppnas inte:** kontrollera att tillägget kör och att du är på hemmanätverket.

Inställningar, listor och historik sparas i tilläggets data och följer med i Home Assistants säkerhetskopior.
