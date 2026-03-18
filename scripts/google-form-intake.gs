/**
 * Google Apps Script — Baker Aviation Form Intake Webhook
 *
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║  INSTALLATION INSTRUCTIONS                                       ║
 * ║                                                                   ║
 * ║  1. Open the Google Form in edit mode                             ║
 * ║  2. Click the three-dot menu → Script editor                     ║
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

  // Create form-submit trigger
  var form = FormApp.getActiveForm();
  ScriptApp.newTrigger("onFormSubmit")
    .forForm(form)
    .onFormSubmit()
    .create();

  Logger.log("Trigger created successfully. Form ID: " + form.getId());
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

  var response = e.response;
  var items = response.getItemResponses();

  // Build the payload from form responses
  var payload = buildPayload(response, items);

  // Attach files (download from Drive, convert to base64)
  payload.files = collectFiles(items);

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

// ── Build payload from form responses ───────────────────────────────────────

function buildPayload(response, items) {
  // Helper to get response by index, returning empty string if missing
  function get(index) {
    if (index < items.length) {
      var r = items[index].getResponse();
      return r != null ? String(r) : "";
    }
    return "";
  }

  function getNum(index) {
    var val = get(index);
    if (!val || val.trim() === "") return null;
    var n = parseFloat(val.replace(/,/g, ""));
    return isNaN(n) ? null : n;
  }

  function getBool(index) {
    var val = get(index).toLowerCase();
    return val === "yes" || val === "true" || val === "y";
  }

  return {
    timestamp: response.getTimestamp().toISOString(),
    first_name: get(0),
    last_name: get(1),
    email: get(2),
    phone: get(3),
    address: get(4),
    nearest_airport: get(5),
    second_airport: get(6),
    certificate_level: get(7),
    total_time: getNum(8),
    total_time_airplane: getNum(9),
    total_time_me_turbine: getNum(10),
    total_pic_time: getNum(11),
    has_ce750_type: getBool(12),
    has_cl30_type: getBool(13),
    typed_hours_last_12mo: get(14),
    last_sim_training: get(15),
    other_type_ratings: get(16),
    has_first_class_medical: getBool(17),
    has_special_issuance: getBool(18),
    medical_issued: get(19),
    medical_expires: get(20),
    has_prd_access: get(21),
    has_accidents: get(22),
    has_training_agreement: get(23),
    training_agreement_owe: get(24),
    available_start: get(25),
    position_applying_for: get(26),
  };
}

// ── Collect file uploads → base64 ──────────────────────────────────────────

function collectFiles(items) {
  var files = [];

  // File upload question indices and their categories
  var fileQuestions = [
    { index: 27, category: "resume" },
    { index: 28, category: "drivers_license" },
    { index: 29, category: "medical" },
    { index: 30, category: "pilot_cert_front" },
    { index: 31, category: "pilot_cert_back" },
  ];

  for (var q = 0; q < fileQuestions.length; q++) {
    var fq = fileQuestions[q];
    if (fq.index >= items.length) continue;

    var item = items[fq.index];
    var itemType = item.getItem().getType();

    // File upload items return an array of Drive file IDs
    if (itemType === FormApp.ItemType.FILE_UPLOAD) {
      var fileIds = item.getResponse();
      if (!fileIds || !Array.isArray(fileIds)) continue;

      for (var f = 0; f < fileIds.length; f++) {
        try {
          var driveFile = DriveApp.getFileById(fileIds[f]);
          var blob = driveFile.getBlob();

          // Skip files over 10MB to stay within Apps Script limits
          if (blob.getBytes().length > 10 * 1024 * 1024) {
            Logger.log("Skipping large file: " + driveFile.getName() + " (" + blob.getBytes().length + " bytes)");
            continue;
          }

          files.push({
            name: driveFile.getName(),
            category: fq.category,
            mimeType: blob.getContentType(),
            base64: Utilities.base64Encode(blob.getBytes()),
          });
        } catch (err) {
          Logger.log("Failed to download file " + fileIds[f] + ": " + err.toString());
        }
      }
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
