# Prompt do wdrożenia aktualizacji bota Discord

Wklej poniższy tekst do terminala Claude Code (`claude`) na laptopie-serwerze:

---

```
Zaktualizuj kod bota Discord na tym serwerze. Wykonaj po kolei:

1. Przejdź do katalogu repozytorium homelab:
   cd /opt/homelab

2. Pobierz najnowsze zmiany z GitHuba (branch claude/bot-thread-command-vSo5b lub main jeśli już zmergowany):
   git fetch origin
   git pull origin claude/bot-thread-command-vSo5b

   Jeśli pull zakończy się konfliktem, pokaż mi błąd i poczekaj.

3. Sprawdź czy plik discord-bot/bot.js został zaktualizowany:
   git log --oneline -3 discord-bot/bot.js

4. Zrestartuj kontener discord-bot żeby załadował nowy kod:
   docker compose restart discord-bot

5. Poczekaj 5 sekund i sprawdź czy kontener działa poprawnie:
   docker compose ps discord-bot
   docker compose logs --tail=20 discord-bot

6. Zgłoś wynik: czy bot wystartował bez błędów, i czy w logach widać "Logged in as:".

Jeśli coś pójdzie nie tak (błąd Node.js, brak modułu itp.), pokaż mi pełny błąd z logów i zaproponuj naprawę.
```

---

## Co robi ta aktualizacja

Komenda `!claude <prompt>` teraz **otwiera wątek Discord** zamiast odpowiadać w kanale.

### Jak używać

1. Wpisz `!claude sprawdź co nie działa na serwerze` w kanale bota
2. Bot tworzy wątek o nazwie `🤖 Claude: sprawdź co nie działa...`
3. W wątku możesz pisać bezpośrednio — każda wiadomość trafia do Claude z pełną historią rozmowy
4. Widać myślenie Claude (`💭 Myślenie Claude:`) gdy model używa extended thinking
5. `!exit` w wątku kończy sesję i archiwizuje wątek
6. Sesja wygasa automatycznie po 30 minutach nieaktywności

### Nowe ustawienie w .env

```
CLAUDE_SESSION_TIMEOUT=30   # minuty nieaktywności przed wygaśnięciem sesji
```
