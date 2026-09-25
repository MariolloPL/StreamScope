Tak. Poniżej masz pełny handoff/spec StreamScope, który możesz wkleić Claude’owi praktycznie 1:1. Zawiera zarówno to, co już ustaliliśmy funkcjonalnie, jak i ważne szczegóły wynikające z naszych realnych logów i testów.
StreamScope — pełny opis projektu i zasad działania
1. Cel projektu
StreamScope ma być lokalnym narzędziem webowym do analizy jakości game streamingu.
Główny przypadek użycia:
Gaming PC / host → Vibepollo/Sunshine → StreamLight na mini-PC K12 → TV
Narzędzie ma zastąpić ręczne wrzucanie ogromnych logów do ChatGPT i ręczne szukanie interesujących fragmentów.
Użytkownik powinien móc po prostu wrzucić pliki z nowej sesji i dostać:
- automatycznie wykryte parametry sesji,
- timeline,
- metryki hosta i klienta,
- wykresy,
- markery początku/końca gameplayu,
- możliwość wybrania konkretnego fragmentu,
- zapis wyników,
- porównanie z wcześniejszymi sesjami,
- krótki raport do przekazania AI.
AI nie powinno być podstawą obliczeń. Wszystkie statystyki powinny być liczone deterministycznie w JavaScript/TypeScript.
2. Architektura
Pierwsza wersja ma być całkowicie statyczną aplikacją webową:
HTML
CSS
JavaScript / TypeScript
Bez backendu.
Docelowe hostowanie:
GitHub
↓
GitHub Pages
↓
https://mariollopl.github.io/StreamScope/
Repozytorium już istnieje:
MariolloPL/StreamScope
GitHub przechowuje tylko kod aplikacji.
Logi użytkownika nie powinny trafiać na GitHub ani na żaden serwer.
Analiza odbywa się lokalnie w przeglądarce.
3. Privacy / local-first
To jest bardzo ważna zasada projektu.
Po wybraniu pliku przez użytkownika:
StreamLight.log
Vibepollo.json
JavaScript używa File API i czyta dane lokalnie.
Przepływ:
GitHub Pages
     ↓
kod StreamScope
     ↓
przeglądarka użytkownika
     ↓
lokalne pliki
     ↓
parser
     ↓
metryki / wykresy
Pliki nie powinny być uploadowane na serwer.
W UI dobrze pokazywać informację w stylu:
Files are processed locally in your browser.

4. Platformy
Aplikacja powinna dobrze działać zarówno na:
Windows PC
K12
iPhone / Safari
iPad
Na telefonie użytkownik może wybierać pliki z aplikacji Files, np. z:
iCloud Drive
OneDrive
SMB
lokalnych plików iPhone'a
UI powinien być responsywny.
Docelowo warto zrobić PWA / Add to Home Screen, ale nie jest to wymagane dla MVP.
5. Źródła danych
Na początku obsługujemy dwa główne formaty.
Źródło	Urządzenie	Format
StreamLight	K12/client	tekstowy .log
Vibepollo/Sunshine	gaming PC/host	session .json


W przyszłości:
CapFrameX
Steam Remote Play
PyroWave
Moonlight
inne telemetry logs
6. StreamLight — co parser powinien odczytać
Przykładowy plik:
StreamLight-1790280529.log
Unix timestamp znajdujący się w nazwie jest bardzo przydatny do synchronizacji z hostem.
StreamLight zawiera informacje konfiguracyjne oraz końcowe statystyki sesji.
Interesujące pola:
resolution
stream FPS
codec
configured bitrate
display refresh rate
VRR requested
VRR enabled
V-Sync
render backend
decoder
oraz końcowe:
Incoming frame rate
Decoding frame rate
Rendering frame rate

Host processing latency:
min
max
avg

Frames dropped by network connection
Frames dropped due to jitter

Average network latency
Network variance

Average decoding time
Average frame queue delay
Average rendering time including monitor VSync

VRR Active
Smoothness
Client interval error
Dropped frames
Przykład znanej sesji:
2560x1440 @ 120
HEVC
75 Mbps

incoming ≈ 92.11 FPS
decoding ≈ 92.11
rendering ≈ 92.08

network loss 0.00%
jitter loss 0.03%

network latency ≈ 1 ms
decode ≈ 0.30 ms
frame queue ≈ 2.78 ms
render ≈ 1.45 ms

VRR = Active
7. Bardzo ważna pułapka StreamLight bitrate
Końcowy wpis typu:
Bitrate: 1.3 Mbps
Peak(10s): 21.0 Mbps
nie oznacza średniego bitrate całej sesji.
To jest stan z końcówki sesji / krótkiego okna.
Nie wolno porównywać tego z rzeczywistym średnim bitrate rajdu policzonym z Vibepollo.
8. VRR
StreamScope powinien rozpoznawać m.in.:
VRR requested
VRR enabled
D3D11 VRR backend enabled
VRR pacing: Active
W znanym działającym setupie StreamLight raportuje prawdziwe:
D3D11 VRR backend enabled
VRR pacing: Active
Pole:
Smoothness (2m): 74.23%
nie oznacza 74 FPS.
To metryka frame pacingu StreamLighta względem targetu VRR.
Nie powinna być prezentowana jako frame rate.
9. Steam Controller jako marker
To istotna część całego workflow.
Steam Controller jest podłączony do K12, a nie do gaming PC.
GameSir używany do grania jest podłączony bezpośrednio do hosta.
Dlatego wpis:
Gamepad 0 is gone
dotyczy Steam Controllera na K12.
Użytkownik celowo włącza/wyłącza Steam Controllera, aby zostawić marker czasowy w logu.
Przykładowe zdarzenia:
00:05:07 Gamepad 0 is gone
00:05:09 Steam Controller detected

00:28:14 Gamepad 0 is gone
00:28:17 Steam Controller detected
StreamScope powinien automatycznie wykrywać te zdarzenia i wyświetlać np.:
05:07 Controller OFF
05:09 Controller ON

28:14 Controller OFF
28:17 Controller ON
Każdy marker powinien mieć przyciski:
Set as start
Set as end
10. Docelowo lepsze markery
Jeżeli powstanie fork StreamLighta, można dodać specjalny hotkey zapisujący bezpośrednio:
USER_MARKER: RAID_START
USER_MARKER: RAID_END
To byłoby lepsze niż power-cycle Steam Controllera.
StreamScope powinien być przygotowany na takie markery.
11. Vibepollo / Sunshine JSON
To główne źródło telemetryczne hosta.
Plik może mieć dziesiątki tysięcy linii.
Znane pola w sample:
timestamp_unix
session_uuid

actual_fps
actual_bitrate_kbps
encode_latency_ms
frame_interval_jitter_ms

frames_sent

client_reported_losses
video_dropped

CPU usage
GPU usage
encoder usage
VRAM
temperature

RFI / reference frame invalidation information
12. Ważne: jeden JSON może zawierać kilka sesji
To już faktycznie wystąpiło.
Vibepollo JSON zawierał dwie sesje:
session UUID A
~73 s

session UUID B
~3594 s
Nie można po prostu analizować wszystkich samples.
Parser powinien użyć:
event_type = stream_started
event_type = stream_ended
session_uuid
timestamp_unix
i rozdzielić sesje.
W prostym MVP można domyślnie wybrać najdłuższą sesję.
Docelowo aplikacja powinna wyświetlać wszystkie wykryte sesje i pozwalać wybrać właściwą.
13. Synchronizacja StreamLight ↔ Vibepollo
To bardzo ważne.
StreamLight operuje swoim czasem sesji:
00:28:17
a Vibepollo ma:
timestamp_unix
Nazwa StreamLight:
StreamLight-1790280529.log
zawiera Unix timestamp.
Można więc mapować:
Vibepollo timestamp_unix
-
StreamLight start timestamp
=
czas względem początku StreamLight
Przykładowo marker StreamLight:
28:17
powinien odpowiadać właściwemu timestamp_unix w Vibepollo.
To pozwala analizować dokładnie ten sam raid po obu stronach.
14. Wybór zakresu
UI powinno mieć:
Start
End
Trim last N minutes
Przykład:
Start: 28:17
End: 1:00:04
Trim last: 3 min
daje:
28:17 → 57:04
To był rzeczywisty zakres użyty wcześniej do analizy całego drugiego raidu.
15. Host metrics — obliczenia
Dla wybranego przedziału czasu StreamScope powinien liczyć:
Metryka	Znaczenie
Avg FPS	średnie actual_fps
Median / P50	mediana FPS
P5 FPS	5 percentile
P1 FPS	1 percentile
FPS >= 90	procent czasu
FPS >= 100	procent czasu
frames_sent FPS	kontrolna wartość z delty frames_sent / time
Avg bitrate	średnie actual_bitrate_kbps
P95 bitrate	percentile bitrate
Avg encode latency	średnie encode_latency_ms
P95 encode latency	95 percentile
losses	suma client-reported losses
video dropped	suma dropped frames


16. Przykład rzeczywistych wyników
Dla wcześniejszego drugiego raidu:
28:17 → 57:04
duration ≈ 28m47s

actual_fps mean ≈ 94.56 FPS

FPS based on frames_sent:
≈ 94.52 FPS

median:
≈ 94.5 FPS

P5:
≈ 85 FPS

P1:
≈ 79.8 FPS

FPS >= 100:
≈ 18.9%

FPS >= 90:
≈ 78.9%

FPS < 90:
≈ 21.1%

average bitrate:
≈ 48.3 Mbps

average encode latency:
≈ 6.93 ms

median encode:
≈ 5.0 ms

P95 encode:
≈ 15.3 ms

client reported losses:
0

video dropped:
0
StreamScope powinien generować właśnie tego typu statystyki automatycznie.
17. Kontrola jakości danych
actual_fps nie powinno być jedynym sposobem liczenia FPS.
Należy również policzyć:
(frames_sent_end - frames_sent_start)
/
(timestamp_end - timestamp_start)
Jeżeli obie wartości są bliskie, mamy dobrą kontrolę spójności.
W przykładowej sesji:
94.56
vs
94.52
czyli bardzo dobra zgodność.
18. Ważna interpretacja FPS
Trzeba rozróżniać trzy rzeczy:
game FPS
Sunshine/Vibepollo actual_fps
StreamLight incoming/render FPS
To nie zawsze jest to samo.
W poprzednich testach:
Sunshine actual_fps ≈ 92.09
StreamLight incoming ≈ 92.11
StreamLight render ≈ 92.08
czyli:
host stream cadence ≈ client receive cadence
To wskazuje, że K12 i sieć praktycznie nie gubią klatek.
Natomiast jeżeli gra renderuje np.:
115 FPS
a Sunshine wysyła:
95 FPS
problem / ograniczenie jest wcześniej:
game
↓
capture
↓
Sunshine
↓
encode
Aby to sprawdzić potrzebny jest CapFrameX.
19. CapFrameX — przyszła integracja
Docelowo StreamScope powinien przyjmować także CapFrameX.
Wtedy można pokazać jeden timeline:
Game FPS
↓
Host stream FPS
↓
Client incoming FPS
↓
Client rendered FPS
To pozwoli dokładnie znaleźć miejsce, gdzie ginie cadence.
20. Global averages nie zawsze są reprezentatywne
Pełna sesja może zawierać:
Steam Big Picture
menu
loading screens
lobby
raid
powrót do lobby
Dlatego global:
Avg FPS 92
nie musi oznaczać:
raid FPS 92
Kluczowa funkcja StreamScope to analiza konkretnego zakresu gameplayu.
21. Wykresy
MVP powinien mieć co najmniej:
FPS vs time
encode latency vs time
Następnie warto dodać:
bitrate vs time
frame interval jitter
GPU usage
encoder usage
CPU usage
network loss events
RFI events
Wszystkie wykresy powinny korzystać z tej samej osi czasu.
Docelowo crosshair / hover powinien pokazywać wartości wszystkich metryk w jednym momencie.
22. RFI / Reference Frame Invalidation
StreamLight logi zawierają sporadyczne zdarzenia typu:
predicted loss
invalidate
speculative RFI mode
Przykładowo wcześniej pojawiały się około:
06:53
23:19
28:19
33:00
39:19
39:25
47:57
48:13
53:56
Są rzadkie i nie oznaczają automatycznie problemu.
W przyszłości warto pokazać je jako pionowe markery na timeline.
23. Historia sesji
Po analizie użytkownik może kliknąć:
Save session
Nie należy zapisywać całych ogromnych logów.
Wystarczy zachować małe podsumowanie:
{
  "date": "...",
  "app": "ARC Raiders",
  "streamer": "StreamLight",
  "resolution": "2560x1440",
  "target_fps": 120,
  "codec": "HEVC",
  "bitrate_setting": 75,
  "avg_fps": 94.56,
  "p5_fps": 85,
  "p1_fps": 79.8,
  "encode_avg_ms": 6.93,
  "encode_p95_ms": 15.3
}
24. Storage
MVP może używać:
localStorage
Docelowo lepiej:
IndexedDB
zwłaszcza jeżeli historia będzie bardziej rozbudowana.
Dane są przypisane do danej przeglądarki/urządzenia.
Czyli historia Safari na iPhonie nie będzie automatycznie taka sama jak historia Chrome na PC.
25. Backup
Powinny istnieć:
Export database
Import database
Eksport np.:
streamscope-backup.json
Można go przechowywać na OneDrive/iCloud.
26. Compare Sessions
To jeden z najważniejszych przyszłych ekranów.
Przykład:
StreamLight
1440p120
HEVC
75 Mbps

vs

PyroWave
1440p120
300 Mbps
Porównanie:
Metric	StreamLight	PyroWave	Difference
Avg FPS	94.5	102.6	+8.1
P5 FPS	…	…	…
Encode	…	…	…
Network	…	…	…
Decode	…	…	…
Queue	…	…	…
Bitrate	…	…	…
Loss	…	…	…


Nie należy automatycznie ogłaszać „winnera”.
Tool pokazuje dane.
27. PyroWave
StreamScope powinien docelowo obsługiwać również Steam Remote Play / PyroWave.
W obecnych Steam SessionStats spotykaliśmy m.in.:
AvgFPS
SlowGame
SlowCapture
SlowConvert
SlowEncode
SlowNetwork
SlowDecode
SlowDisplay

AvgServerBitrate
AvgLinkBandwidth

AvgPing
AvgNetwork
AvgDecode
AvgDisplay
AvgFrame
Ważna interpretacja:
Steam AvgFPS
jest metryką stream/session, nie autorytatywnym game FPS.
Menu i loading mogą zaniżać wynik.
28. PyroWave — queue time
W testach społeczności okazało się, że przy bardzo wysokim bitrate PyroWave może zacząć kolejkować dane.
Dlatego StreamScope powinien eksponować:
queue time
network time
decode time
a nie tylko:
FPS
Przykład:
500 Mbps może działać dobrze
750 Mbps może dodać ~11 ms queue
Większy bitrate nie musi oznaczać lepszego streamingu.
29. AI integration
AI ma być warstwą końcową, nie parserem.
StreamScope liczy wszystko sam.
Następnie może generować mały JSON:
{
  "streamer": "StreamLight",
  "resolution": "2560x1440",
  "target_fps": 120,
  "avg_fps": 94.52,
  "p5_fps": 85,
  "encode_avg_ms": 6.93,
  "encode_p95_ms": 15.3,
  "network_loss_percent": 0,
  "decode_ms": 0.30,
  "vrr": true
}
i przycisk:
Copy for ChatGPT
generujący np.:
StreamScope session report

App: ARC Raiders
Mode: 2560x1440 @120 HEVC
Range: 28:17–57:04

Host:
94.56 avg FPS
85 P5
79.8 P1
48.3 Mbps
6.93 ms encode avg
15.3 ms encode P95

Client:
92.11 incoming
92.08 render
0.00% loss
0.30 ms decode
2.78 ms queue
VRR active
Dzięki temu AI nie musi analizować 50 000 linii.
30. Lokalny agent — przyszłość
GitHub Pages nie może dowolnie czytać plików z dysku.
Dlatego w zwykłej wersji:
Open StreamScope
→ Select files
Docelowo można stworzyć mały:
StreamScope Agent
działający na Windows.
Przykład:
StreamScope Agent.exe
        │
        ├── watches K12 log folder
        └── watches Vibepollo folder
Agent może wystawić lokalne API:
localhost
i StreamScope automatycznie pobiera nowe sesje.
31. Jeszcze lepszy wariant
K12 i host mogą zapisywać logi do wspólnego folderu SMB:
D:\StreamingLogs\
    Host\
    K12\
StreamScope Agent obserwuje oba katalogi i automatycznie tworzy sesję.
Wtedy workflow może być:
gram raid
↓
kończę stream
↓
otwieram StreamScope
↓
sesja już jest
bez uploadowania czegokolwiek ręcznie.
32. Aktualny sprzęt użytkownika
To może się przydać Claude’owi przy interpretacji danych.
Host:
AMD Ryzen 5 7600
RTX 4070 SUPER
Client:
GMKtec K12
AMD Radeon 780M
Windows
Połączenie:
wired Gigabit Ethernet
TV:
Sony XH90
4K
120 Hz
VRR
Typowy StreamLight:
2560x1440
120 Hz
HEVC
75 Mbps
VRR ON
33. Aktualny praktyczny stan streamingu
W obecnym setupie nie ma wyraźnego problemu technicznego.
StreamLight działa dobrze:
VRR active
network loss essentially zero
decode ~0.3 ms
very low LAN latency
stable rendering
StreamScope jest więc głównie:
benchmarking
comparison
diagnostics
history
experimentation
a nie narzędziem do naprawiania obecnie zepsutego systemu.
34. Zasada interpretacji wyników
Narzędzie nie powinno automatycznie pisać:
PyroWave is better
StreamLight is better
Powinno mówić:
PyroWave:
+8 FPS
+210 Mbps
-0.4 ms decode
+3.2 ms network

StreamLight:
lower bitrate
better image according to user
VRR confirmed
Ostateczna ocena należy do użytkownika.
35. MVP, które już zostało zaprojektowane
Aktualny MVP ma:
drag & drop files

StreamLight parser
Vibepollo parser

multi-session Vibepollo detection

Steam Controller markers

start/end range

trim last N minutes

host FPS:
avg
P50
P5
P1

frames_sent FPS

encode:
avg
P95

bitrate:
avg
P95

% >=90 FPS
% >=100 FPS

client:
incoming FPS
render FPS
network loss
jitter loss
network latency
decode time
queue delay
VRR

FPS chart
encode chart

Save session

Export JSON

Copy for ChatGPT

local history
Pierwsza wersja została napisana jako pojedynczy:
index.html
z embedded CSS i JS.
36. Repozytorium
Repo istnieje:
github.com/MariolloPL/StreamScope
i jest publiczne.
GitHub Pages ma być docelowym hostingiem.
Aktualnie kod MVP nie został jeszcze zapisany do repo, ponieważ GitHub connector ChatGPT ma dostęp do metadanych repo, ale próba:
create_file
zakończyła się:
403
Resource not accessible by integration
Czyli trzeba jeszcze poprawić instalację/uprawnienia GitHub App dla repo StreamScope.
37. Proponowana kolejność dalszych prac
Najpierw doprowadzić do solidnego:
StreamLight + Vibepollo MVP
i zweryfikować liczby na prawdziwych logach.
Następnie:
better UI
Compare
CapFrameX
PyroWave
persistent database
PWA
local StreamScope Agent
Nie ma sensu zaczynać od backendu, logowania użytkowników ani AI API.
38. Najważniejsza filozofia projektu
StreamScope powinien być:
local-first
deterministic
fast
privacy friendly
easy to use
useful on phone and desktop
Schemat:
RAW LOGS
   ↓
deterministic parsers
   ↓
normalized session
   ↓
selected gameplay range
   ↓
metrics
   ↓
charts / compare
   ↓
compact AI report
Nie:
RAW LOGS
↓
AI
↓
maybe correct answer
To jest w zasadzie komplet wiedzy, którą mamy teraz o StreamScope. Jeśli wrzucisz to Claude’owi, powinien mieć praktycznie cały kontekst potrzebny, żeby kontynuować projekt bez ponownego tłumaczenia, co i dlaczego budujemy.