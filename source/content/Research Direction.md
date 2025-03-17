```dataview
TABLE L.text as "Question"
FROM "source/content"
FLATTEN file.lists as L
WHERE contains(L.tags, "#look-into")
```
