# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Jedna osoba: autor (Mario). Analizuje własne sesje game streamingu na własnym sprzęcie: gamingowy PC (host, Vibepollo/Sunshine, Steam Remote Play / PyroWave) → mini-PC K12 (StreamLight / Moonlight) → TV. Używa StreamScope na komputerze, nigdy na telefonie. Interfejs po polsku.

## Product Purpose
Zastępuje ręczne wrzucanie ogromnych logów do AI i ręczne szukanie fragmentów. Dwa równie ważne zadania:
1. **Werdykt po sesji:** czy było dobrze, co ograniczało jakość, zapis do historii.
2. **Strojenie (A/B):** po zmianie ustawienia (kodek, bitrate, VRR, enkoder) porównanie z wcześniejszymi sesjami, żeby ocenić skutek zmiany.

Sukces: po sesji szybko widać wynik 1–10, werdykt i co ogranicza, a porównanie dwóch sesji pokazuje różnice w danych bez ręcznej analizy logów.

## Positioning
Łączy host (Vibepollo JSON, Steam `streaming_log`) i klienta (logi StreamLight/Moonlight, telemetria StreamTweak, VRR trace) na jednej osi czasu, z automatycznym parowaniem po czasie i markerami pada wyznaczającymi fragment rozgrywki. Reguły diagnostyczne są skalibrowane na realnych sesjach autora.

## Operating Context
- Agent (`agent/streamscope_agent.py`) na gamingowym PC zbiera logi do archiwum i serwuje aplikację lokalnie (`http://localhost:8765/`).
- Markery: odłączenie/podłączenie pada na K12 na początku i końcu mierzonego fragmentu.
- Raport tekstowy dla AI kopiowany do schowka jako uzupełnienie, nie podstawa obliczeń.

## Capabilities and Constraints
- Działa lokalnie; nie musi działać na GitHub Pages ani na telefonie (potwierdzone przez autora). Wsparcie GitHub Pages / układu mobilnego opisane w README można traktować jako opcjonalne.
- Obecny stos: czysty HTML/CSS/JS bez budowania, wykresy SVG własne, IndexedDB/localStorage, agent w Pythonie (tylko stdlib).
- Statystyki liczone deterministycznie w JS; porównanie pokazuje dane i nie wskazuje „zwycięzcy” (zasada z README).
- Werdykt: ocena 1–10 = średnia testów, najwyżej 1,5 pkt powyżej najsłabszego; FPS, obraz i zapas hosta tylko informacyjnie.
- Czas w UI lokalny; nazwy plików Vibepollo w UTC.
- CapFrameX i PresentMon: rozpoznawane, nieobsługiwane.

## Brand Commitments
Nazwa: StreamScope. Język interfejsu: polski. Brak innych zobowiązań wizualnych potwierdzonych przez autora.

## Evidence on Hand
- Prawdziwe pliki sesji autora (lokalnie, poza repo; nie commitować).
- `claude/analizator-sesji.html` i `claude/streamscope-handoff.md`: pierwotny analizator i wyniki walidacji na 8 sesjach.
- Brak użytkowników zewnętrznych, opinii czy benchmarków porównawczych; nie wymyślać ich.

## Product Principles
1. Najpierw odpowiedź: wynik, werdykt i czynnik ograniczający, potem szczegóły.
2. Dane, nie opinie: każda liczba ma źródło; porównanie nie ogłasza zwycięzcy.
3. Zero ręcznej roboty: parowanie, markery i zbieranie logów działają automatycznie.
4. Narzędzie dla jednego eksperta: gęstość informacji i precyzja ważniejsze niż prowadzenie za rękę.
