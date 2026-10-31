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

## Lagring på nätverksdisk (t.ex. AirPort Extreme)

Pausbufferten för live-tv, matchinspelningar och nedladdade filmer kan ligga på en nätverksdisk i stället för Home Assistants egen disk.

1. Anslut disken i Home Assistant: **Inställningar → System → Lagring → Lägg till nätverkslagring**. Välj protokoll **SMB**, ange diskens adress (AirPort: routerns IP) och delningens namn, och välj användning **Media**. Ge den ett kort namn, t.ex. `airport`. Den dyker då upp som `/media/airport`.
2. Skriv samma namn under tilläggets **Konfiguration → storage_dir** (`airport`, eller hela sökvägen `/media/airport`) och starta om tillägget.
3. Under **Min sida → Nedladdningar** i Norrsken står det var filerna sparas och hur mycket som är ledigt. Går disken inte att skriva till (avstängd, inte monterad) sparar Norrsken i stället på tilläggets egen disk och säger det där.

Obs: en gammal AirPort Extreme pratar äldre SMB-versioner. Om Home Assistant inte kan montera disken beror det oftast på det, inte på Norrsken.

## Nedladdningar

Tryck på **Ladda ner** på en film eller ett avsnitt (eller **Ladda ner säsongen**). Servern sparar filen som MP4 på lagringsdisken: bilden kopieras orörd, ljud som iPhone/tv:n inte kan spela (DTS, TrueHD) görs om till E-AC-3. Nedladdade titlar spelas från servern och använder inte leverantörens anslutning. Under **Min sida → Nedladdningar** kan du spela, spara filen på telefonen eller datorn, eller ta bort den.

Leverantören ger bara en eller ett par anslutningar. Därför väntar en nedladdning tills ingen tittar, och den pausas (och börjar om från början) när du startar något annat eller en matchinspelning ska börja.

## PIN-kod för inställningarna

Sidan `/setup` innehåller ditt konto hos leverantören och kräver därför alltid en PIN-kod.

- Vid första starten skapas en sexsiffrig PIN-kod. Den står i tilläggets **Logg** (raden `PIN för /setup`).
- Vill du välja en egen: skriv den under tilläggets **Konfiguration → setup_pin** och starta om tillägget.
- Fem fel i rad ger en väntetid som fördubblas för varje nytt fel (upp till 15 minuter).

## Kryptering av leverantörens uppgifter

Lägg raden som visas under Leverantör på `/setup` (`norrsken_nyckel: …`) i Home Assistants `secrets.yaml` och starta om tillägget. Då sparas användarnamn och lösenord krypterade.

## Tv-guiden går fel i tid

Visar en match eller ett program fel klockslag (t.ex. en timme sent) är det oftast leverantörens guide som anger tiden fel, inte Norrsken. Sätt tilläggets `epg_offset` i minuter: `-60` flyttar alla guidetider en timme tidigare, `60` en timme senare. Efter omstart skriver loggen en rad `[tvguide] exempel: starttid "…" blir hh:mm svensk tid` som visar vad guiden faktiskt skickar. Gäller både XMLTV-guide och leverantörens egen guide. Ändras tiden vid nästa sommar-/vintertid, justera värdet då.

## Time Capsule / AirPort Extreme som lagring (pausbuffert och matchinspelningar)

En Time Capsule pratar bara det gamla SMB1-protokollet. Home Assistants "Lägg till nätverkslagring" kan inte montera den, så använd i stället tilläggets egen anslutning:

1. Sätt `smb_share` till disken, t.ex. `//192.168.1.5/Data` (IP eller namn på Time Capsule, och diskens delningsnamn). Sätt `smb_user` och `smb_password` (lämna tomma om disken saknar lösenord). `smb_dir` är mappen på disken, standard `Norrsken`; Norrsken skapar den själv.
2. Starta om tillägget. Loggen skriver `[time capsule] ansluten`, eller varför det inte gick (fel lösenord, fel delningsnamn, disken svarar inte).

Så fungerar det: pausen och matchinspelningen skrivs först i en liten lokal mapp, färdiga delar (4 sekunder) kopieras direkt till Time Capsule och de gamla lokala delarna tas bort. Spolar du tillbaka hämtas delarna tillbaka därifrån. Tappar disken förbindelsen sparas allt lokalt tills den är tillbaka. Är `storage_dir` (monterad disk) också satt och fungerar, används den i stället.

Nedladdningar ligger kvar på tilläggets egen disk (eller på `storage_dir`).
