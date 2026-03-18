/**
 * Google Apps Script — Baker Aviation Form Intake Webhook
 *
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║  INSTALLATION INSTRUCTIONS                                       ║
 * ║                                                                   ║
 * ║  1. Open the Google Sheet (Form Responses)                         ║
 * ║  2. Click Extensions → Apps Script                               ║
 * ║  3. Paste this entire file into Code.gs (replace any existing)   ║
 * ║  4. Set script properties (Project Settings → Script Properties): ║
 * ║     - WEBHOOK_URL = https://your-domain.com/api/public/form-intake║
 * ║     - INTAKE_SECRET = (same value as FORM_INTAKE_SECRET env var) ║
 * ║  5. Run setup() once from the script editor (Run → setup)        ║
 * ║     - This creates the form-submit trigger automatically         ║
 * ║     - Grant permissions when prompted                             ║
 * ║  6. Submit a test form entry to verify it works                   ║
 * ║                                                                   ║
 * ║  IMPORTANT: The form must have file-upload questions for the      ║
 * ║  script to download and send files. Each file-upload question     ║
 * ║  should be labeled with its category (Resume, Driver's License,   ║
 * ║  Medical Certificate, etc.)                                       ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Expected form columns (in order):
 *  1. Timestamp
 *  2. First Name
 *  3. Last Name
 *  4. Email Address
 *  5. Phone Number
 *  6. Mailing Address
 *  7. Nearest Airport (3-letter code)
 *  8. Second Nearest Airport
 *  9. Certificate Level (Commercial / ATP)
 * 10. Total Flight Time
 * 11. Total Time — Airplane
 * 12. Total Time — Multi-Engine Turbine
 * 13. Total PIC Time
 * 14. CE-750 (Citation X) Type Rating? (Yes/No)
 * 15. CL-30 (Challenger 300/350) Type Rating? (Yes/No)
 * 16. Typed Hours Last 12 Months
 * 17. Last Sim Training Date
 * 18. Other Type Ratings
 * 19. First Class Medical? (Yes/No)
 * 20. Special Issuance? (Yes/No)
 * 21. Medical Certificate Issued Date
 * 22. Medical Certificate Expiration
 * 23. PRD Access? (Yes/No/Applied)
 * 24. Any Accidents/Incidents/Violations?
 * 25. Currently Under Training Agreement? (Yes/No)
 * 26. Training Agreement Amount Owed
 * 27. Available Start Date
 * 28. Position Applying For (PIC / SIC)
 * 29. Resume (file upload)
 * 30. Driver's License (file upload)
 * 31. Medical Certificate (file upload)
 * 32. Pilot Certificate — Front (file upload)
 * 33. Pilot Certificate — Back (file upload)
 */

// ── Setup: run this once to create the trigger ──────────────────────────────

function setup() {
  // Remove any existing triggers to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "onFormSubmit") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create spreadsheet form-submit trigger (works when script is attached to the Sheet)
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger("onFormSubmit")
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();

  Logger.log("Trigger created successfully. Spreadsheet: " + ss.getName());
}

// ── Main trigger handler ────────────────────────────────────────────────────

function onFormSubmit(e) {
  var props = PropertiesService.getScriptProperties();
  var webhookUrl = props.getProperty("WEBHOOK_URL");
  var intakeSecret = props.getProperty("INTAKE_SECRET");

  if (!webhookUrl || !intakeSecret) {
    Logger.log("ERROR: WEBHOOK_URL or INTAKE_SECRET not set in script properties");
    return;
  }

  // Spreadsheet trigger: e.values is an array of all cell values in the new row
  // e.namedValues is a map of column header → [value]
  var values = e.values || [];
  var nv = e.namedValues || {};

  // Build the payload from row values (by index, matching column order)
  var payload = buildPayloadFromValues(values, nv);

  // Collect file URLs from the Drive link columns and download them
  payload.files = collectFilesFromValues(values);

  // Send to webhook
  var options = {
    method: "post",
    contentType: "application/json",
    headers: {
      "x-intake-secret": intakeSecret,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  try {
    var result = UrlFetchApp.fetch(webhookUrl, options);
    var code = result.getResponseCode();
    var body = result.getContentText();

    if (code >= 200 && code < 300) {
      Logger.log("Webhook success: " + body);
    } else {
      Logger.log("Webhook error " + code + ": " + body);
      // Retry once after 2 seconds
      Utilities.sleep(2000);
      var retry = UrlFetchApp.fetch(webhookUrl, options);
      Logger.log("Retry result " + retry.getResponseCode() + ": " + retry.getContentText());
    }
  } catch (err) {
    Logger.log("Webhook request failed: " + err.toString());
  }
}

// ── Build payload from spreadsheet row values ────────────────────────────────

function buildPayloadFromValues(values, namedValues) {
  // values[] is indexed by column: 0=Timestamp, 1=First Name, 2=Last Name, ...
  function get(index) {
    if (index < values.length && values[index] != null) {
      return String(values[index]).trim();
    }
    return "";
  }

  function getNum(index) {
    var val = get(index);
    if (!val) return null;
    var n = parseFloat(val.replace(/,/g, ""));
    return isNaN(n) ? null : n;
  }

  function getBool(index) {
    var val = get(index).toLowerCase();
    return val === "yes" || val === "true" || val === "y";
  }

  return {
    timestamp: get(0) || new Date().toISOString(),
    first_name: get(1),
    last_name: get(2),
    email: get(3),
    phone: get(4),
    address: get(5),
    nearest_airport: get(6),
    second_airport: get(7),
    certificate_level: get(8),
    total_time: getNum(9),
    total_time_airplane: getNum(10),
    total_time_me_turbine: getNum(11),
    total_pic_time: getNum(12),
    has_ce750_type: getBool(13),
    has_cl30_type: getBool(14),
    typed_hours_last_12mo: get(15),
    last_sim_training: get(16),
    other_type_ratings: get(17),
    has_first_class_medical: getBool(18),
    has_special_issuance: getBool(19),
    medical_issued: get(20),
    medical_expires: get(21),
    has_prd_access: get(22),
    has_accidents: get(23),
    has_training_agreement: get(24),
    training_agreement_owe: get(25),
    available_start: get(26),
    position_applying_for: get(32), // last column
  };
}

// ── Collect file uploads from spreadsheet Drive URLs → base64 ────────────────

function collectFilesFromValues(values) {
  var files = [];

  // Column indices for file upload fields (contain Google Drive URLs)
  // 27=Resume, 28=Driver License, 29=Medical, 30=Pilot Cert Front, 31=Pilot Cert Back
  var fileColumns = [
    { index: 27, category: "resume" },
    { index: 28, category: "drivers_license" },
    { index: 29, category: "medical" },
    { index: 30, category: "pilot_cert_front" },
    { index: 31, category: "pilot_cert_back" },
  ];

  for (var q = 0; q < fileColumns.length; q++) {
    var fc = fileColumns[q];
    if (fc.index >= values.length) continue;

    var url = String(values[fc.index] || "").trim();
    if (!url) continue;

    // Extract Drive file ID from URL: https://drive.google.com/open?id=XXXXX
    var fileId = null;
    var idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) {
      fileId = idMatch[1];
    } else {
      // Try /d/XXXXX/ format
      var dMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (dMatch) fileId = dMatch[1];
    }

    if (!fileId) {
      Logger.log("Could not extract file ID from URL: " + url);
      continue;
    }

    try {
      var driveFile = DriveApp.getFileById(fileId);
      var blob = driveFile.getBlob();

      // Skip files over 10MB
      if (blob.getBytes().length > 10 * 1024 * 1024) {
        Logger.log("Skipping large file: " + driveFile.getName() + " (" + blob.getBytes().length + " bytes)");
        continue;
      }

      files.push({
        name: driveFile.getName(),
        category: fc.category,
        mimeType: blob.getContentType(),
        base64: Utilities.base64Encode(blob.getBytes()),
      });
    } catch (err) {
      Logger.log("Failed to download file " + fileId + ": " + err.toString());
    }
  }

  return files;
}

// ── Manual test function ────────────────────────────────────────────────────

function testWebhook() {
  var props = PropertiesService.getScriptProperties();
  var webhookUrl = props.getProperty("WEBHOOK_URL");
  var intakeSecret = props.getProperty("INTAKE_SECRET");

  var testPayload = {
    timestamp: new Date().toISOString(),
    first_name: "Test",
    last_name: "Pilot",
    email: "test@example.com",
    phone: "555-123-4567",
    address: "123 Runway Ave, Dallas TX 75201",
    nearest_airport: "DAL",
    second_airport: "DFW",
    certificate_level: "ATP",
    total_time: 5000,
    total_time_airplane: 4800,
    total_time_me_turbine: 2500,
    total_pic_time: 2000,
    has_ce750_type: true,
    has_cl30_type: false,
    typed_hours_last_12mo: "300",
    last_sim_training: "2026-01-15",
    other_type_ratings: "CE-525, LR-45",
    has_first_class_medical: true,
    has_special_issuance: false,
    medical_issued: "2026-01-01",
    medical_expires: "2027-01-01",
    has_prd_access: "Yes",
    has_accidents: "No",
    has_training_agreement: "No",
    training_agreement_owe: "",
    available_start: "2026-04-01",
    position_applying_for: "PIC — Captain",
    files: [],
  };

  var options = {
    method: "post",
    contentType: "application/json",
    headers: { "x-intake-secret": intakeSecret },
    payload: JSON.stringify(testPayload),
    muteHttpExceptions: true,
  };

  var result = UrlFetchApp.fetch(webhookUrl, options);
  Logger.log("Status: " + result.getResponseCode());
  Logger.log("Body: " + result.getContentText());
}


// ── Backfill: download files from all existing rows and send to webhook ──────

function backfillFiles() {
  var props = PropertiesService.getScriptProperties();
  var webhookUrl = props.getProperty("WEBHOOK_URL");
  var intakeSecret = props.getProperty("INTAKE_SECRET");

  if (!webhookUrl || !intakeSecret) {
    Logger.log("ERROR: Set WEBHOOK_URL and INTAKE_SECRET in Script Properties first");
    return;
  }

  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheets()[0]; // First sheet (Form Responses)
  var data = sheet.getDataRange().getValues();
  var headers = data[0];

  var success = 0;
  var failed = 0;
  var noFiles = 0;

  // Start from row 2 (skip header)
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var email = String(row[3] || "").trim().toLowerCase();
    var name = String(row[1] || "") + " " + String(row[2] || "");

    if (!email) {
      Logger.log("Row " + (i + 1) + ": no email, skipping");
      continue;
    }

    // Collect files from this row
    var files = collectFilesFromValues(row);

    if (files.length === 0) {
      noFiles++;
      Logger.log("Row " + (i + 1) + " (" + name.trim() + "): no files to download");
      continue;
    }

    // Send just the files + email to the webhook (it will match by email and attach)
    var payload = buildPayloadFromValues(row, {});
    payload.files = files;

    var options = {
      method: "post",
      contentType: "application/json",
      headers: { "x-intake-secret": intakeSecret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };

    try {
      var result = UrlFetchApp.fetch(webhookUrl, options);
      var code = result.getResponseCode();
      if (code >= 200 && code < 300) {
        success++;
        Logger.log("Row " + (i + 1) + " (" + name.trim() + "): " + files.length + " files sent OK");
      } else {
        failed++;
        Logger.log("Row " + (i + 1) + " (" + name.trim() + "): ERROR " + code + " — " + result.getContentText().substring(0, 200));
      }
    } catch (err) {
      failed++;
      Logger.log("Row " + (i + 1) + " (" + name.trim() + "): FAILED — " + err.toString());
    }

    // Pause between rows to avoid rate limits
    Utilities.sleep(1000);
  }

  Logger.log("\n=== BACKFILL COMPLETE ===");
  Logger.log("Files sent: " + success);
  Logger.log("No files: " + noFiles);
  Logger.log("Failed: " + failed);
}
