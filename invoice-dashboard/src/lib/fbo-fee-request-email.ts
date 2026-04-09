/**
 * Email template + helpers for FBO fee request outreach.
 * Sends from operations@baker-aviation.com requesting detailed fee schedules.
 */

export interface FeeRequestTarget {
  airport_code: string;
  fbo_name: string;
  fbo_email: string;
  aircraft_types: string[]; // e.g. ["Citation X", "Challenger 300"]
  request_id?: number; // DB row ID for reply matching
}

/**
 * Build the email subject line for a fee request.
 */
export function buildSubject(target: FeeRequestTarget): string {
  return `Baker Aviation — Fee Schedule Request for ${target.airport_code}`;
}

/**
 * Build the HTML email body requesting specific fee data.
 * Designed to be crystal clear so FBO CSRs provide complete responses.
 */
export function buildFeeRequestHtml(target: FeeRequestTarget): string {
  const aircraftList = target.aircraft_types
    .map((t) => `<li><strong>${t}</strong></li>`)
    .join("\n");

  return `
<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #222; max-width: 680px;">

  <p>Hey there,</p>

  <p>
    I'm Evan over at <strong>Baker Aviation</strong> — we fly Challenger 300s and Citation Xs
    and we come through <strong>${target.airport_code}</strong> pretty regularly.
  </p>

  <p>
    I'm putting together an updated fee sheet for all of our airports and was hoping
    you could send over your current rates for our two aircraft types. Trying to get
    everything in one place so our dispatch team isn't guessing anymore.
  </p>

  <p>
    Here's what I'm looking for if you have it — for both the <strong>Challenger 300</strong>
    and <strong>Citation X</strong>:
  </p>

  <ul style="margin: 10px 0; padding-left: 20px; color: #333;">
    <li><strong>Jet-A retail price</strong> — your current posted rate per gallon (not contract)</li>
    <li><strong>Handling / facility fee</strong> — per arrival</li>
    <li><strong>How many gallons to waive the handling fee</strong></li>
    <li><strong>Infrastructure / ramp fee</strong> — if you guys charge one</li>
    <li><strong>Security fee</strong></li>
    <li><strong>Overnight ramp parking</strong> — per night or hourly, however you do it</li>
    <li><strong>Hangar</strong> — flat rate + hourly if that's how it works</li>
    <li><strong>GPU</strong></li>
    <li><strong>Lav service</strong></li>
    <li><strong>De-ice</strong> — Type I / IV if applicable</li>
    <li><strong>After-hours / call-out fee</strong> — if applicable</li>
  </ul>

  <p>
    If fees are different between the two aircraft just let me know the breakdown.
    Totally fine to just send a PDF fee schedule too if that's easier — whatever works.
  </p>

  <p>Thanks a lot, really appreciate it!</p>

  <p style="margin-top: 20px;">
    Evan<br>
    <strong>Baker Aviation Operations</strong><br>
    <a href="mailto:operations@baker-aviation.com" style="color: #1e3a5f;">operations@baker-aviation.com</a>
  </p>

  <p style="font-size: 10px; color: #ccc; margin-top: 24px;">Ref: BA-FEE-${target.request_id || "0000"}</p>

</div>
`.trim();
}

/**
 * Build plain-text version for preview / fallback.
 */
export function buildFeeRequestPlainText(target: FeeRequestTarget): string {
  return `Hey there,

I'm Evan over at Baker Aviation — we fly Challenger 300s and Citation Xs and we come through ${target.airport_code} pretty regularly.

I'm putting together an updated fee sheet for all of our airports and was hoping you could send over your current rates for our two aircraft types. Trying to get everything in one place so our dispatch team isn't guessing anymore.

Here's what I'm looking for if you have it — for both the Challenger 300 and Citation X:

  - Jet-A retail price — your current posted rate per gallon (not contract)
  - Handling / facility fee — per arrival
  - How many gallons to waive the handling fee
  - Infrastructure / ramp fee — if you guys charge one
  - Security fee
  - Overnight ramp parking — per night or hourly, however you do it
  - Hangar — flat rate + hourly if that's how it works
  - GPU
  - Lav service
  - De-ice — Type I / IV if applicable
  - After-hours / call-out fee — if applicable

If fees are different between the two aircraft just let me know the breakdown. Totally fine to just send a PDF fee schedule too if that's easier — whatever works.

Thanks a lot, really appreciate it!

Evan
Baker Aviation Operations
operations@baker-aviation.com`;
}
