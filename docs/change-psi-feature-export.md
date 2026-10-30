## UI-Title Web
    kita ganti Title Text pada web dan export report dari yang awalnya "Mobile 100% Inspection" --> "PSI Inspection Report" 

## Home Page

    |01| Top 5 Defect kita ganti ke All Defect termasuk Foto per defectnya. required
    |02| Pada Information result, kita tampilkan juga Data "Inspection Rework QTY", datanya diambil dari perhitungan input inspection Rework type.
    |03| tambahkan form input "Rework and Approved" di information Result. 

## Defect Input

    |01| Default Tombol End Inspection Disable sebelum User input click Defect Listnya (Rework & B-Grade).
    |02| Defect Result List harus merefresh ulang ketika akan melakukan inspection baru.

## Export Format Excel and PDF

### Excel
    Export data excel mengikuti format yang telah saya lampirkan di Reference/excel-format/excel-template.xlsx

    dan berikut kita sesuaikan Data nya seperti berikut :

***Part I : Generate Data***
    - Date --> Date Inspection atau data submit PO
    - PSI Name

***Part II : KPI Summary***
    - Inspected QTY --> QTY Inspection
    - Inspected QTY (Including Rework) --> QTY Inspection + Inspection Rework QTY
    - Rejected Order QTY --> QTY Inspection - A-Grade
    - RFT %
    - Defect % --> Defect Rate %
    - Not Reworkable Defect QTY --> B-Grade QTY
    - Not Reworkable Defect % --> B-Grade %
    - Total Approved --> total A-Grade

***Part III : Daily Inspection Summary***
    - PO No.
    - Model Name
    - QTY Order 
    - Destination
    - Offered Lot QTY --> QTY Partial
    - Inspected QTY --> QTY Inspection
    - Inspected QTY (Including Rework) --> QTY Inspection + Inspection Rework QTY
    - Approved QTY --> A-grade
    - Reject QTY --> QTY Inspection - A-Grade
    - Rework and Approved
    - Pairs Not Reworkable & Not Shippable (B&C Grade)
    - Balance QTY --> Offered Lot - QTY Inspection
    - Balance Rework --> Inspection Rework QTY - Rework and Approved

***Defect Findings List***
    - menampilkan keseluruhan List Defect Hasil Inspection lengkap dengan QTY Defectnya dan Lever Severity nya.

### PDF
**Header**
    - Title Report kita ganti dari "MOBILE 100% INSPECTION" ke "PSI Inspection Report"
    - Title Text "DICETAK" kita ganti menjadi Date Inspection, data Date nya juga mengacu pada tanggal inspection nya / Date Submit PO
    - Table Top 5 Defect kita ubah menampilkan data ALL Defect Result Inspection
    - Foto Defectnya juga kita tampilkan Semua Per defect hasil inspection.