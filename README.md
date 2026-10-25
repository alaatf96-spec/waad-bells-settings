# Waad Bells settings

Every Waad Bells board reads `timetable.csv` from here every 3 hours (and when the app is opened, or when **Refresh the timetable** is pressed on the control page). Change a time here and all boards follow, with nothing to install.

Columns: `kind, group, days, time, early, date, label, value, active`
- `bell` rows: `group` = primary (G4–6) / secondary (G7–12) / all, `days` like SUN-WED or THU, `time` = when the class ends (the board rings `ringEarly` = 2 minutes before), `value` = sound (calm, bell, end, chime, adhan).
- `setting` rows: `label` = setting name, `value` = its value (volume, adhanVolume, adhanUrl, controlUrl …).

This file is public: keep only times and settings in it, never names or passwords.
