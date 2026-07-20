# Verwijderknop in "Klaar voor publicatie"

## Wat

De "Klaar voor publicatie"-kolom in `Pipeline.tsx` mist een verwijderknop.
Alle andere kolommen met artikel-cards ("Beelden nodig") hebben die al.

## Aanpak

Hergebruik het bestaande patroon 1-op-1: een `✕`-knop (`btn-small`, title
"Verwijderen") die de al bestaande `deleteArticle(a)`-functie aanroept
(confirm-dialoog → `DELETE /api/articles/:id` → draft naar WP-prullenbak).
Geen nieuwe logica nodig.

## Plaatsing

Naast de bestaande "Publiceren"- en ✎-knoppen in de kaart, binnen dezelfde
`display:flex` knoppenrij (`Pipeline.tsx` rond regel 582-586).

## Buiten scope

Geen wijziging aan `deleteArticle`, aan de API, of aan andere kolommen.
