import { escapeHtml } from "./email";

/**
 * Shared HTML shell for outgoing email, adapted from the Bliu Interactive (Vent) MJML template: a soft
 * grey card with the group's wordmark and a divider, the message body, then a small grey footer.
 * Table-based with Outlook conditionals so it renders in Gmail, Apple Mail and Outlook alike.
 * `bodyHtml` and `footerHtml` are trusted HTML; everything else is escaped here.
 */
export function emailLayout(opts: { title: string; preheader: string; brand: string; brandUrl: string; bodyHtml: string; footerHtml: string }) {
  const t = escapeHtml(opts.title);
  const font = "font-family:'ABC Repro',Inter,'Segoe UI',Helvetica,Arial,sans-serif";
  const ink = "#062010";
  const card = "background-color:#f4f4f3"; // rgba(29,29,27,0.05) on white, flattened for Outlook
  const msoOpen = `<!--[if mso | IE]><table align="center" border="0" cellpadding="0" cellspacing="0" style="width:600px;" width="600"><tr><td style="line-height:0px;font-size:0px;mso-line-height-rule:exactly;"><![endif]-->`;
  const msoClose = `<!--[if mso | IE]></td></tr></table><![endif]-->`;
  return `<!doctype html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <title>${t}</title>
  <!--[if !mso]><!--><meta http-equiv="X-UA-Compatible" content="IE=edge"><!--<![endif]-->
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style type="text/css">
    #outlook a { padding: 0; }
    body { margin: 0; padding: 0; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { border-collapse: collapse; mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    p { display: block; margin: 13px 0; }
    @media only screen and (max-width:480px) { .card { margin-top: 0 !important; border-radius: 0 !important; } }
  </style>
  <!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
</head>
<body style="word-spacing:normal;background-color:#ffffff;">
  <div style="display:none;font-size:1px;color:#ffffff;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">${escapeHtml(opts.preheader)}</div>
  <div style="background-color:#ffffff;">
    ${msoOpen}
    <div class="card" style="margin:0px auto;max-width:600px;${card};border-radius:16px;margin-top:5%;">
      <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;">
        <tbody>
          <tr>
            <td style="direction:ltr;font-size:0px;padding:20px 0 8px;text-align:left;">
              <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">
                <tbody>
                  <tr>
                    <td align="left" style="padding:10px 25px;word-break:break-word;">
                      <a href="${escapeHtml(opts.brandUrl)}" style="${font};font-size:18px;font-weight:700;letter-spacing:-0.01em;color:${ink};text-decoration:none;">${escapeHtml(opts.brand)}</a>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="font-size:0px;padding:10px 25px;word-break:break-word;">
                      <p style="border-top:solid 1px rgba(6,32,16,0.08);font-size:1px;margin:0px auto;width:100%;"></p>
                      <!--[if mso | IE]><table align="center" border="0" cellpadding="0" cellspacing="0" style="border-top:solid 1px #e6e8e6;font-size:1px;margin:0px auto;width:550px;" role="presentation" width="550px"><tr><td style="height:0;line-height:0;">&nbsp;</td></tr></table><![endif]-->
                    </td>
                  </tr>
                  <tr>
                    <td align="left" style="padding:4px 25px 24px;word-break:break-word;${font};font-size:15px;line-height:1.55;color:${ink};">
                      ${opts.bodyHtml}
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    ${msoClose}
    ${msoOpen}
    <div style="margin:0px auto;max-width:600px;">
      <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;">
        <tbody>
          <tr>
            <td align="left" style="padding:16px 25px 24px;word-break:break-word;${font};font-size:12px;line-height:1.6;color:rgba(6,32,16,0.6);">
              ${opts.footerHtml}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    ${msoClose}
  </div>
</body>
</html>`;
}

/** Pill button that survives Outlook (bulletproof table button). */
export function emailButton(href: string, label: string) {
  return `<table border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate;margin:18px 0 6px;">
  <tr><td align="center" bgcolor="#2f5d46" style="border-radius:999px;background:#2f5d46;">
    <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 26px;font-family:'ABC Repro',Inter,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
  </td></tr>
</table>`;
}
