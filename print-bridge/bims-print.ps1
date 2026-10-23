# bims-print.ps1 — programa local de impresión de BIMS ERP (v2, reemplaza a zpl-bridge.ps1).
# Escucha en http://127.0.0.1:9101 y manda los bytes crudos (ZPL/TSPL para etiquetas, ESC/POS
# para tickets) en modo RAW directo a la cola de Windows que pide el sistema — sin pasar por el
# diálogo de impresión del navegador. Cada pedido dice a QUÉ impresora va (Ajustes > Impresión),
# así una PC con etiquetadora + impresora de tickets nunca cruza un trabajo con la otra.
#
#   GET  /status  -> {ok, app, version, printers:[{name, default}]}
#   POST /print   -> body {printerName, data, copies}   (también acepta {zpl} del bridge v1)
#
# Instalación: doble click a "instalar.bat" (se copia a %LOCALAPPDATA%\BIMS-Print, arranca solo
# con Windows y apaga el bridge viejo si estaba). Uso manual: "iniciar.bat".

param(
  [string]$PrinterName = "",
  [int]$Port = 9101,
  [switch]$Instalar
)

$Version = "2.0"

# ── Modo instalación ─────────────────────────────────────────────────────────────────────────
if ($Instalar) {
  $dest = Join-Path $env:LOCALAPPDATA "BIMS-Print"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $destScript = Join-Path $dest "bims-print.ps1"
  Copy-Item -Path $PSCommandPath -Destination $destScript -Force
  try { Unblock-File -Path $destScript } catch {}

  # Apagar cualquier bridge que ya esté corriendo (v1 zpl-bridge o una v2 anterior) — si no, el
  # puerto 9101 queda ocupado y el nuevo no puede arrancar.
  try {
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
      Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'zpl-bridge\.ps1|bims-print\.ps1' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {}

  # Sacar del inicio de Windows los accesos del bridge viejo (iniciar-bridge.bat / zpl-bridge.ps1).
  $startup = [Environment]::GetFolderPath('Startup')
  $wsh = New-Object -ComObject WScript.Shell
  Get-ChildItem -Path $startup -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $lnk = $wsh.CreateShortcut($_.FullName)
      if (($lnk.TargetPath + ' ' + $lnk.Arguments) -match 'zpl-bridge|iniciar-bridge|bims-print') { Remove-Item $_.FullName -Force }
    } catch {}
  }
  Get-ChildItem -Path $startup -Filter 'iniciar-bridge*.bat' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $lnkPath = Join-Path $startup 'BIMS Print.lnk'
  $s = $wsh.CreateShortcut($lnkPath)
  $s.TargetPath = $psExe
  $s.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $destScript + '"'
  $s.WindowStyle = 7   # minimizado
  $s.Description = 'BIMS Print - impresion directa de BIMS ERP'
  $s.Save()

  Start-Process -FilePath $psExe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"' + $destScript + '"')) -WindowStyle Minimized

  Write-Host ""
  Write-Host "  BIMS Print instalado correctamente." -ForegroundColor Green
  Write-Host "  - Ya quedo funcionando (ventana minimizada en la barra de tareas)." -ForegroundColor Green
  Write-Host "  - Arranca solo cada vez que se prende la PC." -ForegroundColor Green
  Write-Host ""
  Write-Host "  Ahora entra a BIMS ERP > Ajustes > Impresion y elegi tus impresoras." -ForegroundColor Yellow
  Write-Host ""
  Read-Host "Presiona Enter para cerrar esta ventana"
  exit 0
}

# ── Envío RAW a la cola de Windows (mismo mecanismo que usa QZ Tray por dentro) ─────────────
Add-Type -Name RawPrinterHelper -Namespace BimsPrint -MemberDefinition @"
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
public struct DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
}
[DllImport("winspool.drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true)]
public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
[DllImport("winspool.drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true)]
public static extern bool ClosePrinter(IntPtr hPrinter);
[DllImport("winspool.drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true)]
public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] ref DOCINFOA di);
[DllImport("winspool.drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true)]
public static extern bool EndDocPrinter(IntPtr hPrinter);
[DllImport("winspool.drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true)]
public static extern bool StartPagePrinter(IntPtr hPrinter);
[DllImport("winspool.drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true)]
public static extern bool EndPagePrinter(IntPtr hPrinter);
[DllImport("winspool.drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true)]
public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

// Devuelve 0 si salió bien, o el código de error de Windows si no.
public static int SendBytes(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return Marshal.GetLastWin32Error();
    int err = 0;
    DOCINFOA di = new DOCINFOA();
    di.pDocName = "BIMS ERP";
    di.pDataType = "RAW";
    if (StartDocPrinter(h, 1, ref di)) {
        if (StartPagePrinter(h)) {
            IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
            Marshal.Copy(bytes, 0, p, bytes.Length);
            int written;
            if (!WritePrinter(h, p, bytes.Length, out written)) err = Marshal.GetLastWin32Error();
            Marshal.FreeCoTaskMem(p);
            EndPagePrinter(h);
        } else err = Marshal.GetLastWin32Error();
        EndDocPrinter(h);
    } else err = Marshal.GetLastWin32Error();
    ClosePrinter(h);
    return err;
}
"@

function Get-Impresoras {
  try {
    return @(Get-CimInstance Win32_Printer -ErrorAction Stop | ForEach-Object { @{ name = [string]$_.Name; default = [bool]$_.Default } })
  } catch {
    Add-Type -AssemblyName System.Drawing
    return @([System.Drawing.Printing.PrinterSettings]::InstalledPrinters | ForEach-Object { @{ name = [string]$_; default = $false } })
  }
}

function Send-Json($response, [int]$status, $obj) {
  $buffer = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $obj -Depth 5 -Compress))
  $response.ContentType = "application/json; charset=utf-8"
  $response.StatusCode = $status
  $response.OutputStream.Write($buffer, 0, $buffer.Length)
}

$Host.UI.RawUI.WindowTitle = "BIMS Print - NO CERRAR (impresion de BIMS ERP)"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
try {
  $listener.Start()
} catch {
  Write-Host "ERROR: el puerto $Port ya esta en uso. Seguramente BIMS Print ya esta abierto (fijate en la barra de tareas)." -ForegroundColor Red
  Read-Host "Presiona Enter para cerrar"
  exit 1
}

Write-Host "BIMS Print v$Version funcionando en http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "Impresoras detectadas en esta PC:" -ForegroundColor Green
Get-Impresoras | ForEach-Object { Write-Host ("  - " + $_.name + $(if ($_.default) { "  (predeterminada)" } else { "" })) }
Write-Host ""
Write-Host "Deja esta ventana abierta (podes minimizarla). Si la cerras, BIMS ERP no puede imprimir." -ForegroundColor Yellow

while ($listener.IsListening) {
  $context = $null
  try { $context = $listener.GetContext() } catch { break }
  $request = $context.Request
  $response = $context.Response
  $response.Headers.Add("Access-Control-Allow-Origin", "*")
  $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
  # Chrome pide este header para dejar que una página pública (https) hable con localhost.
  $response.Headers.Add("Access-Control-Allow-Private-Network", "true")

  try {
    $path = $request.Url.AbsolutePath
    if ($request.HttpMethod -eq "OPTIONS") {
      $response.StatusCode = 204
    }
    elseif ($request.HttpMethod -eq "GET" -and $path -eq "/status") {
      Send-Json $response 200 @{ ok = $true; app = "bims-print"; version = $Version; printers = @(Get-Impresoras) }
    }
    elseif ($request.HttpMethod -eq "POST" -and $path -eq "/print") {
      $reader = New-Object System.IO.StreamReader($request.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd()
      $reader.Close()
      $json = $body | ConvertFrom-Json

      $data = if ($json.data) { [string]$json.data } else { [string]$json.zpl }
      $printer = if ($json.printerName) { [string]$json.printerName } else { $PrinterName }
      $copies = 1
      if ($json.copies) { $copies = [int]$json.copies }
      if ($copies -lt 1) { $copies = 1 }
      if ($copies -gt 500) { $copies = 500 }

      if (-not $printer) {
        Send-Json $response 400 @{ ok = $false; error = "No hay impresora elegida. Elegila en BIMS ERP > Ajustes > Impresion." }
      }
      elseif (-not $data) {
        Send-Json $response 400 @{ ok = $false; error = "Trabajo de impresion vacio." }
      }
      else {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($data * $copies)
        $err = [BimsPrint.RawPrinterHelper]::SendBytes($printer, $bytes)
        $hora = Get-Date -Format "HH:mm:ss"
        if ($err -eq 0) {
          Write-Host "[$hora] OK -> $printer ($copies)"
          Send-Json $response 200 @{ ok = $true }
        } else {
          $msg = if ($err -eq 1801) { "No existe una impresora llamada '$printer' en esta PC." } else { "Windows no pudo enviar a '$printer' (error $err)." }
          Write-Host "[$hora] FALLO -> $printer : $msg" -ForegroundColor Red
          Send-Json $response 500 @{ ok = $false; error = $msg }
        }
      }
    }
    else {
      $response.StatusCode = 404
    }
  } catch {
    Write-Host ("Error: " + $_.Exception.Message) -ForegroundColor Red
    try { Send-Json $response 500 @{ ok = $false; error = "Error interno de BIMS Print" } } catch {}
  } finally {
    $response.Close()
  }
}
