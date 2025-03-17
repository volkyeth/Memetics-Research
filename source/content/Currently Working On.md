```dataview
TABLE dateformat(file.mtime, "dd.MM.yyyy - HH:mm") AS "Last modified", round(file.size / 5) AS "Est. Words" FROM "" WHERE file.size > 0 SORT file.mtime DESC LIMIT 8
```

