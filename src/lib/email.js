// ─────────────────────────────────────────────────────────────
//  Envío de emails transaccionales — SMTP de la casilla de Hostinger
//  (no-responder@ciarbis.com). Un solo lugar para no repetir la config
//  de transporte en cada ruta que necesite mandar un mail.
// ─────────────────────────────────────────────────────────────

import nodemailer from 'nodemailer'

let transporter = null
function getTransporter() {
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.hostinger.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  return transporter
}

export async function sendEmail({ to, subject, html }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn(`[email] SMTP no configurado — no se envió "${subject}" a ${to}`)
    return { skipped: true }
  }
  return getTransporter().sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to, subject, html,
  })
}

const wrapper = (title, bodyHtml) => `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
  <img src="${process.env.APP_URL || 'https://erp.ciarbis.com'}/img/logo-bims-erp-128.png" alt="BIMS ERP" style="height:36px;margin-bottom:20px"/>
  <h2 style="margin:0 0 16px">${title}</h2>
  ${bodyHtml}
  <p style="margin-top:32px;font-size:12px;color:#888">CIARBIS Soluciones — BIMS ERP</p>
</div>`

export function emailConfirmacionCuenta({ nombre, empresa, email, password, url }) {
  return wrapper('¡Bienvenido a BIMS ERP!', `
    <p>Hola ${nombre},</p>
    <p>Se creó la cuenta de <strong>${empresa}</strong>. Guardá estos datos de acceso:</p>
    <div style="background:#f4f4f4;border-radius:8px;padding:14px 18px;margin:16px 0;font-size:14px">
      <div>Usuario: <strong>${email}</strong></div>
      <div>Contraseña: <strong>${password}</strong></div>
    </div>
    <p style="font-size:13px;color:#a15c00;background:#fff6e5;border-radius:8px;padding:10px 14px">⚠️ Por seguridad te sugerimos cambiar esta contraseña la primera vez que entres (Configuración → Mi perfil).</p>
    <p>Confirmá tu dirección de email haciendo clic acá:</p>
    <p style="margin:24px 0"><a href="${url}" style="background:#00d4aa;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">Confirmar mi cuenta</a></p>
    <p style="font-size:13px;color:#666">Ya podés usar el sistema con normalidad aunque no confirmes — este email es solo para verificar que la dirección es correcta.</p>
  `)
}

export function emailRecuperoPassword({ nombre, url }) {
  return wrapper('Recuperar contraseña', `
    <p>Hola ${nombre},</p>
    <p>Pediste restablecer tu contraseña. Hacé clic acá para elegir una nueva (el enlace vence en 1 hora):</p>
    <p style="margin:24px 0"><a href="${url}" style="background:#00d4aa;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600">Restablecer contraseña</a></p>
    <p style="font-size:13px;color:#666">Si no pediste esto, ignorá el email — tu contraseña actual sigue funcionando.</p>
  `)
}
