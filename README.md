# StreamScope

Lokalne narzędzie webowe do analizy jakości game streamingu:
**Vibepollo/Sunshine (host) → StreamLight/Moonlight (klient)**.

Wrzucasz plik sesji hosta i log klienta. StreamScope sam je paruje po czasie, znajduje markery pada, liczy benchmark dla wybranego fragmentu rozgrywki, pokazuje diagnostykę całej sesji i przygotowuje krótki raport dla AI.

Pliki są przetwarzane **lokalnie w przeglądarce** i nigdzie nie są wysyłane. Repozytorium zawiera tylko kod aplikacji.

## Obsługiwane pliki

| Źródło | Plik | Co z niego bierzemy |
|---|---|---|
| Vibepollo / Sunshine (host) | `sunshine-session-<App>-<czas UTC>.json` | próbki co ~2 s: FPS, bitrate, enkodowanie, CPU/GPU/enkoder, straty, IDR/RFI; połączenia (`session_uuid`) |
| StreamLight / Moonlight (klient) | `StreamLight-<unix>.log`, `Moonlight-<unix>.log` | konfiguracja streamu, VRR/V-sync, markery pada, zdarzenia RFI/IDR, statystyki końcowe („Global video stats”) |

CapFrameX i PresentMon są rozpoznawane, ale jeszcze nieobsługiwane.

## Jak używać

1. Otwórz stronę i przeciągnij pliki (można wiele naraz).
2. Wybierz sesję z listy.
3. Ustaw zakres rozgrywki: przyciskami przy markerach pada, wpisując czas (np. `28:17`–`1:00:04`, przycięcie końca o N minut) albo przeciągając po wykresie.
4. **Zapisz do historii**, **Kopiuj raport dla AI** albo porównaj zapisane sesje w zakładce *Historia i porównanie*.

Markery: wyłącz i włącz pad podłączony do klienta na początku i na końcu fragmentu, który chcesz zmierzyć. W logu pojawi się `Gamepad N is gone` i ponowne wykrycie pada. Parser nie zależy od modelu pada. Obsługuje też przyszłe wpisy `USER_MARKER: <nazwa>`.

## Uruchomienie lokalne

Wystarczy otworzyć `index.html` w przeglądarce, bez budowania. Można też uruchomić dowolny serwer statyczny:

```bash
python -m http.server 8765
```

## Struktura

```
index.html              układ strony
css/app.css             style (jasny i ciemny motyw)
js/core.js              statystyki (percentyle z interpolacją liniową), formatowanie czasu
js/parsers/vibepollo.js parser JSON-a sesji hosta
js/parsers/clientlog.js parser logów StreamLight/Moonlight (wiele streamów w jednym logu)
js/engine/session.js    parowanie host ↔ klient, synchronizacja zegarów, benchmark zakresu
js/engine/diagnostics.js silnik diagnostyczny (reguły z analizatora sesji)
js/storage.js           historia (localStorage), eksport/import, raport dla AI
js/chart.js             wykresy SVG na wspólnej osi czasu
js/app.js               interfejs
```

## Zasady obliczeń

- Czas w nazwach plików Vibepollo to UTC. W interfejsie wszystko jest w czasie lokalnym.
- Synchronizacja: epoka z nazwy logu klienta plus czas linii daje przybliżony czas uniksowy. Resztkowe przesunięcie zegarów (zwykle kilka sekund) mierzymy względem najbliższego `stream_started` w pliku hosta.
- Liczniki Vibepollo są kumulatywne w obrębie `session_uuid`, więc liczymy przyrosty per połączenie. `encode_latency_ms = 0` jest pomijane.
- Statystyki klienta dotyczą całego streamu. Końcowy „Bitrate / Peak (10s)” to stan z ostatnich sekund, a „Smoothness (2m)” to metryka równości klatek przy VRR, nie FPS.
- StreamScope nie wskazuje „zwycięzcy” porównania. Pokazuje tylko dane.
