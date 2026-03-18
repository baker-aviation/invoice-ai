-- Seed PIC and SIC offer letter templates
INSERT INTO offer_templates (role, name, html_body) VALUES
('sic', 'Citation X First Officer Offer Letter', '
<div style="font-family: Georgia, serif; max-width: 750px; margin: 0 auto; padding: 40px; line-height: 1.6; color: #1a1a1a;">

<div style="text-align: right; margin-bottom: 30px;">
  <img src="/baker-logo.png" alt="Baker Aviation" style="height: 60px;" />
</div>

<p style="text-align: right;">{{date}}</p>

<p>Dear <strong>{{candidate_name}}</strong>,</p>

<p>We are pleased to extend the following offer of employment:</p>

<p><strong>Position:</strong> Citation X First Officer<br/>
<strong>Pay Start Date:</strong> {{start_date}}<br/>
<strong>Computer Based Indoc Training Completion Date:</strong> TBD<br/>
<strong>In Person Indoc:</strong> TBD<br/>
<strong>Simulator Training Date:</strong> TBD</p>

<p>You are being hired for the position of Citation X First Officer, with a path to Captain. All new hires will participate in the 8 On 6 Off schedule. There is potential to switch schedules in the future as bidding opportunities arise.</p>

<p>You may notice that we do not require you to sign a training agreement. We try very hard to foster a work environment that attracts pilots to our company while also hiring very selectively so that we all may focus on the work we have to do instead of counting the days until our work is over. We hope you appreciate our trust in you as a Candidate and we certainly look forward to you trusting us.</p>

<p>It is our goal to properly manage the expectations of all new hire pilots to ensure your employment is satisfying and our company is successful. This offer letter will ensure that the terms of your employment are clear and in writing for future reference.</p>

<p>The first step in employment is the execution of this offer letter by You and Baker Aviation LLC. Upon execution of this letter the hiring and training process will begin.</p>

<p>Your start date will typically be no earlier than three weeks before your simulator training date. During this period you will be fully employed by Baker Aviation LLC as a Pilot Candidate so that you may accomplish the many tasks that are required to be completed before arriving at the simulator training. We must work together to complete all items fully before you can start simulator training. You will also be required to attend Baker indoc. This will occur before sim training, and you will be compensated the same as time in the simulator.</p>

<h3 style="margin-top: 30px;">Indoc Training</h3>

<p>During the onboarding and training process you must pass several gates to continue employment:</p>

<p>You will be required to complete pre-employment drug screening, a background check, all computer based Indoc training (CTS/AirTera), and other necessary admin items (PRIA, ATS, KCM, payroll paperwork, etc.) before your indoc start date.</p>

<p>Failure to do so or to report to any in person event will result in termination of employment.</p>

<p>Failure to complete simulator training on schedule will result in evaluation by Baker Aviation Check Airman and the decision to re-train will be at the Operator''s sole discretion.</p>

<h3 style="margin-top: 30px;">Training Pay</h3>

<p>During the training process and until you are flying in the aircraft you will be eligible for the full pay package as it applies. Flight hour pay will not apply as you will not be accruing flight hours until you complete your line check in the aircraft.</p>

<h3 style="margin-top: 30px;">Time Off During Training</h3>

<p>You should expect the training work schedule to be busy. Upon completion of simulator training you should be prepared to report to Baker Aviation for your oral and line check. Upon completion of the line check you may be required to start your line of flying. Time off requests during training will not be approved except in the case of an emergency.</p>

<h3 style="margin-top: 30px;">Time Off During First 6 Months of Employment</h3>

<p>Any time off in the first 6 months of employment is unpaid. Vacation time will start accruing from date of hire, but this time will only become usable after 6 months of employment. For time off to be guaranteed, requests must be submitted in January of that year.</p>

<h3 style="margin-top: 30px;">FO Pay Plan</h3>

<table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
  <tr style="background: #1e3a5f; color: white;">
    <th style="padding: 10px; text-align: left; border: 1px solid #ccc;">Item</th>
    <th style="padding: 10px; text-align: left; border: 1px solid #ccc;">Details</th>
    <th style="padding: 10px; text-align: left; border: 1px solid #ccc;">Notes</th>
  </tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Schedule</strong></td><td style="padding: 8px; border: 1px solid #ddd;">8 On 6 Off</td><td style="padding: 8px; border: 1px solid #ddd;"></td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Total Compensation</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$179,600 without bonus days or overtime</td><td style="padding: 8px; border: 1px solid #ddd;">Including all pay and benefits (excl. per diem) at 65 hrs/month</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Base Salary</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$85,000.00</td><td style="padding: 8px; border: 1px solid #ddd;">Guaranteed regardless of hours flown</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Per Flight Hour Salary</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$60/hr (0-500hrs)<br/>$90/hr (after 500hrs)</td><td style="padding: 8px; border: 1px solid #ddd;">$46,800–$70,020 annually @ 65 hrs/month. 500hr annual guarantee. 20hr/week standby guarantee.</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Standby Guarantee</strong></td><td style="padding: 8px; border: 1px solid #ddd;">20 hours guaranteed on standby</td><td style="padding: 8px; border: 1px solid #ddd;"></td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Annual Guarantee</strong></td><td style="padding: 8px; border: 1px solid #ddd;">500 hour annual guarantee</td><td style="padding: 8px; border: 1px solid #ddd;">All full time pilots fly 600-700 hours/year</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>401(K) Company Match</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$30/flight hour<br/>$23,400 annually @ 65 hrs/month</td><td style="padding: 8px; border: 1px solid #ddd;">6 month vesting for new hires</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>ESOP Retirement Plan</strong></td><td style="padding: 8px; border: 1px solid #ddd;">Annual contribution by company at no cost</td><td style="padding: 8px; border: 1px solid #ddd;">6 year vesting — 2nd retirement plan in addition to 401K</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Per Diem</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$85 Domestic</td><td style="padding: 8px; border: 1px solid #ddd;">$125 International</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Health, Dental, Vision</strong></td><td style="padding: 8px; border: 1px solid #ddd;">Fully paid by company (Single or Family)</td><td style="padding: 8px; border: 1px solid #ddd;">Effective 1st of month following 60 days</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>PTO/Vacation</strong></td><td style="padding: 8px; border: 1px solid #ddd;">21 days per year</td><td style="padding: 8px; border: 1px solid #ddd;">Prorated from hiring date</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Sick Days</strong></td><td style="padding: 8px; border: 1px solid #ddd;">5 per year</td><td style="padding: 8px; border: 1px solid #ddd;">Company buy-back at $1,000/day. Prorated from hire date.</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Bonus Day</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$1,500</td><td style="padding: 8px; border: 1px solid #ddd;">Volunteer to go on rotation early for $1,500</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Training Agreement</strong></td><td style="padding: 8px; border: 1px solid #ddd;">Not Required</td><td style="padding: 8px; border: 1px solid #ddd;"></td></tr>
</table>

<h3 style="margin-top: 30px;">401K</h3>

<p>Baker Aviation is pleased to offer a 401K contribution to our pilots. You will receive a company contribution based on flight hours, as stated above. Pilots do not have to contribute to receive this contribution, the 401K is a pure benefit to all Baker pilots. You will be eligible for 401K accrual upon completing your line check and beginning your rotation in the aircraft. Company 401k contributions vest after 6 months of employment.</p>

<h3 style="margin-top: 30px;">ESOP Retirement Plan</h3>

<p>Baker Aviation is an Employee Owned business through an Employee Stock Ownership Plan. This means that each year you will receive shares of the company into your ESOP retirement account. This benefit is at no cost to you and in addition to the 401k retirement plan. You will have 2 retirement plans both funded by the company at no cost to you.</p>

<h3 style="margin-top: 30px;">Health/Dental/Vision</h3>

<p>Baker Aviation provides Health, Dental, and Vision care to all employees and their dependents within limits of our plan at no cost to the employee. All insurance plans become effective the 1st of the month following 60 days of employment. Any employee who elects to not participate in health, vision and dental will receive an additional $500 per month in regular compensation.</p>

<p style="margin-top: 30px;">This offer and your employment are contingent upon satisfactory results from required background checks, drug screening requirements, and eligibility to work in the United States under the Immigration Reform and Control Act.</p>

<p>Please complete your employment verification by signing this acknowledgment and return it to us confirming your acceptance.</p>

<p style="margin-top: 20px; font-size: 18px; font-weight: bold;">Welcome Aboard!</p>

<p>Sincerely,</p>

<div style="margin-top: 40px;">
  <p>_____________________________&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;________________</p>
  <p>Timothy Livingston&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Date</p>
  <p>President</p>
</div>

<div style="margin-top: 40px;">
  <p>_____________________________&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;________________</p>
  <p>{{candidate_name}}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Date</p>
</div>

</div>
'),
('pic', 'Citation X Captain Offer Letter', '
<div style="font-family: Georgia, serif; max-width: 750px; margin: 0 auto; padding: 40px; line-height: 1.6; color: #1a1a1a;">

<div style="text-align: right; margin-bottom: 30px;">
  <img src="/baker-logo.png" alt="Baker Aviation" style="height: 60px;" />
</div>

<p style="text-align: right;">{{date}}</p>

<p>Dear <strong>{{candidate_name}}</strong>,</p>

<p>We are pleased to extend the following offer of employment:</p>

<p><strong>Position:</strong> Citation X Captain<br/>
<strong>Pay Start Date:</strong> {{start_date}}<br/>
<strong>Computer Based Indoc Training Completion Date:</strong> TBD<br/>
<strong>In Person Indoc:</strong> TBD<br/>
<strong>Simulator Training Date:</strong> TBD</p>

<p>You are being hired for the position of Citation X Captain. All new hires will participate in the 8 On 6 Off schedule. There is potential to switch schedules in the future as bidding opportunities arise.</p>

<p>You may notice that we do not require you to sign a training agreement. We try very hard to foster a work environment that attracts pilots to our company while also hiring very selectively so that we all may focus on the work we have to do instead of counting the days until our work is over. We hope you appreciate our trust in you as a Candidate and we certainly look forward to you trusting us.</p>

<p>It is our goal to properly manage the expectations of all new hire pilots to ensure your employment is satisfying and our company is successful. This offer letter will ensure that the terms of your employment are clear and in writing for future reference.</p>

<p>The first step in employment is the execution of this offer letter by You and Baker Aviation LLC. Upon execution of this letter the hiring and training process will begin.</p>

<p>Your start date will typically be no earlier than three weeks before your simulator training date. During this period you will be fully employed by Baker Aviation LLC as a Pilot Candidate so that you may accomplish the many tasks that are required to be completed before arriving at the simulator training. We must work together to complete all items fully before you can start simulator training. You will also be required to attend Baker indoc. This will occur before sim training, and you will be compensated the same as time in the simulator.</p>

<h3 style="margin-top: 30px;">Indoc Training</h3>

<p>During the onboarding and training process you must pass several gates to continue employment:</p>

<p>You will be required to complete pre-employment drug screening, a background check, all computer based Indoc training (CTS/AirTera), and other necessary admin items (PRIA, ATS, KCM, payroll paperwork, etc.) before your indoc start date.</p>

<p>Failure to do so or to report to any in person event will result in termination of employment.</p>

<p>Failure to complete simulator training on schedule will result in evaluation by Baker Aviation Check Airman and the decision to re-train will be at the Operator''s sole discretion.</p>

<h3 style="margin-top: 30px;">Training Pay</h3>

<p>During the training process and until you are flying in the aircraft you will be eligible for the full pay package as it applies. Flight hour pay will not apply as you will not be accruing flight hours until you complete your line check in the aircraft.</p>

<h3 style="margin-top: 30px;">Time Off During Training</h3>

<p>You should expect the training work schedule to be busy. Upon completion of simulator training you should be prepared to report to Baker Aviation for your oral and line check. Upon completion of the line check you may be required to start your line of flying. Time off requests during training will not be approved except in the case of an emergency.</p>

<h3 style="margin-top: 30px;">Time Off During First 6 Months of Employment</h3>

<p>Any time off in the first 6 months of employment is unpaid. Vacation time will start accruing from date of hire, but this time will only become usable after 6 months of employment. For time off to be guaranteed, requests must be submitted in January of that year.</p>

<h3 style="margin-top: 30px;">Captain Pay Plan</h3>

<table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
  <tr style="background: #1e3a5f; color: white;">
    <th style="padding: 10px; text-align: left; border: 1px solid #ccc;">Item</th>
    <th style="padding: 10px; text-align: left; border: 1px solid #ccc;">Details</th>
    <th style="padding: 10px; text-align: left; border: 1px solid #ccc;">Notes</th>
  </tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Schedule</strong></td><td style="padding: 8px; border: 1px solid #ddd;">8 On 6 Off</td><td style="padding: 8px; border: 1px solid #ddd;"></td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Total Compensation</strong></td><td style="padding: 8px; border: 1px solid #ddd;">Up to and likely in excess of $274,000</td><td style="padding: 8px; border: 1px solid #ddd;">Including all pay and benefits (excl. per diem) at 65 hrs/month</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Base Salary</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$100,000.00</td><td style="padding: 8px; border: 1px solid #ddd;">Guaranteed regardless of hours flown</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Per Flight Hour Pay</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$180/hr (1st year)<br/>$190/hr (2nd year)<br/>$200/hr (3rd year)<br/>$210/hr (4th year)</td><td style="padding: 8px; border: 1px solid #ddd;">Year 1: $140,400 annually @ 65 hrs/month. Total $240,400. 500hr annual guarantee. 20hr/week standby guarantee.</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>401(K) Company Match</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$30/flight hour<br/>$23,400 annually @ 65 hrs/month</td><td style="padding: 8px; border: 1px solid #ddd;">6 month vesting for new hires</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>ESOP Retirement Plan</strong></td><td style="padding: 8px; border: 1px solid #ddd;">Annual contribution by company at no cost</td><td style="padding: 8px; border: 1px solid #ddd;">6 year vesting — 2nd retirement plan in addition to 401K</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Per Diem</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$85 Domestic</td><td style="padding: 8px; border: 1px solid #ddd;">$125 International</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Health, Dental, Vision</strong></td><td style="padding: 8px; border: 1px solid #ddd;">Fully paid by company (Single or Family)</td><td style="padding: 8px; border: 1px solid #ddd;">Effective 1st of month following 60 days</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>PTO/Vacation</strong></td><td style="padding: 8px; border: 1px solid #ddd;">21 days per year</td><td style="padding: 8px; border: 1px solid #ddd;">Prorated from hiring date</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Sick Days</strong></td><td style="padding: 8px; border: 1px solid #ddd;">5 per year</td><td style="padding: 8px; border: 1px solid #ddd;">Company buy-back at $1,000/day. Prorated from hire date.</td></tr>
  <tr><td style="padding: 8px; border: 1px solid #ddd;"><strong>Bonus Day</strong></td><td style="padding: 8px; border: 1px solid #ddd;">$1,500</td><td style="padding: 8px; border: 1px solid #ddd;">Volunteer to go on rotation early for $1,500</td></tr>
  <tr style="background: #f9f9f9;"><td style="padding: 8px; border: 1px solid #ddd;"><strong>Training Agreement</strong></td><td style="padding: 8px; border: 1px solid #ddd;">Not Required</td><td style="padding: 8px; border: 1px solid #ddd;"></td></tr>
</table>

<h3 style="margin-top: 30px;">401K</h3>

<p>Baker Aviation is pleased to offer a 401K contribution to our pilots. You will receive a company contribution based on flight hours, as stated above. Pilots do not have to contribute to receive this contribution, the 401K is a pure benefit to all Baker pilots. You will be eligible for 401K accrual upon completing your line check and beginning your rotation in the aircraft. Company 401k contributions vest after 6 months of employment.</p>

<h3 style="margin-top: 30px;">ESOP Retirement Plan</h3>

<p>Baker Aviation is an Employee Owned business through an Employee Stock Ownership Plan. This means that each year you will receive shares of the company into your ESOP retirement account. This benefit is at no cost to you and in addition to the 401k retirement plan. You will have 2 retirement plans both funded by the company at no cost to you.</p>

<h3 style="margin-top: 30px;">Health/Dental/Vision</h3>

<p>Baker Aviation provides Health, Dental, and Vision care to all employees and their dependents within limits of our plan at no cost to the employee. All insurance plans become effective the 1st of the month following 60 days of employment. Any employee who elects to not participate in health, vision and dental will receive an additional $500 per month in regular compensation.</p>

<p style="margin-top: 30px;">This offer and your employment are contingent upon satisfactory results from required background checks, drug screening requirements, and eligibility to work in the United States under the Immigration Reform and Control Act.</p>

<p>Please complete your employment verification by signing this acknowledgment and return it to us confirming your acceptance.</p>

<p style="margin-top: 20px; font-size: 18px; font-weight: bold;">Welcome Aboard!</p>

<p>Sincerely,</p>

<div style="margin-top: 40px;">
  <p>_____________________________&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;________________</p>
  <p>Timothy Livingston&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Date</p>
  <p>President</p>
</div>

<div style="margin-top: 40px;">
  <p>_____________________________&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;________________</p>
  <p>{{candidate_name}}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Date</p>
</div>

</div>
')
ON CONFLICT (role) DO NOTHING;
