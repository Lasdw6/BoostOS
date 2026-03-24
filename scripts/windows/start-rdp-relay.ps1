[CmdletBinding()]
param(
    [string]$DistroName = "BoostOS",
    [int]$ListenPort = 3390,
    [string]$TargetHost = "127.0.0.1",
    [int]$TargetPort = 3390
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$source = @"
using System;
using System.Net;
using System.Net.Sockets;
using System.Threading.Tasks;

public static class BoostOsRdpRelay
{
    public static async Task RunAsync(string targetHost, int listenPort, int targetPort)
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, listenPort);
        listener.Start();
        Console.WriteLine(string.Format("BoostOS RDP relay listening on localhost:{0} -> {1}:{2}", listenPort, targetHost, targetPort));

        while (true)
        {
            TcpClient client = await listener.AcceptTcpClientAsync();
            client.NoDelay = true;
            Task ignored = HandleClientAsync(client, targetHost, targetPort);
        }
    }

    private static async Task HandleClientAsync(TcpClient client, string targetHost, int targetPort)
    {
        using (client)
        using (var upstream = new TcpClient())
        {
            upstream.NoDelay = true;
            await upstream.ConnectAsync(targetHost, targetPort);

            using (NetworkStream clientStream = client.GetStream())
            using (NetworkStream upstreamStream = upstream.GetStream())
            {
                Task toTarget = PumpAsync(clientStream, upstreamStream, delegate
                {
                    try { upstream.Client.Shutdown(SocketShutdown.Send); } catch { }
                });
                Task toClient = PumpAsync(upstreamStream, clientStream, delegate
                {
                    try { client.Client.Shutdown(SocketShutdown.Send); } catch { }
                });

                await Task.WhenAll(Suppress(toTarget), Suppress(toClient));
            }
        }
    }

    private static async Task PumpAsync(NetworkStream input, NetworkStream output, Action onComplete)
    {
        byte[] buffer = new byte[64 * 1024];
        try
        {
            while (true)
            {
                int read = await input.ReadAsync(buffer, 0, buffer.Length);
                if (read <= 0)
                {
                    break;
                }

                await output.WriteAsync(buffer, 0, read);
                await output.FlushAsync();
            }
        }
        finally
        {
            try { onComplete(); } catch { }
        }
    }

    private static async Task Suppress(Task task)
    {
        try { await task; } catch { }
    }

    private static async Task Suppress(Task<string> task)
    {
        try { await task; } catch { }
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp
[BoostOsRdpRelay]::RunAsync($TargetHost, $ListenPort, $TargetPort).GetAwaiter().GetResult()
