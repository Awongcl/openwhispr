// Watcher fork (spec O14): BLE central for the SenseCAP Watcher custom GATT link.
// Dumb transport: finds paired "Watcher AI XXXX" devices, keeps a GATT session open
// (Windows reconnects by itself while MaintainConnection is set), subscribes to the
// Event and Audio characteristics and forwards bytes. All protocol logic lives in
// src/watcher/linkProtocol.js. Contract: firmware/docs/link-protocol.md (main repo).
//
// Built with the .NET Framework csc.exe that ships with Windows (C# 5, no NuGet):
// see scripts/build-watcher-ble.js.
//
// stdout (one line each):  READY | PAIRED <addr> <name> | UNPAIRED <addr> |
//   CONN <addr> <mtu> <info hex> | DISC <addr> | EVT <addr> <hex> | AUDIO <addr> <hex> |
//   WERR <addr> <reason> | LOG <text>
// stdin:  W <addr|*> <hex>  (write Control, with response)  |  QUIT

using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Enumeration;
using Windows.Foundation;
using Windows.Security.Cryptography;
using Windows.Storage.Streams;

// Awaiting WinRT async operations without System.Runtime.WindowsRuntime (whose
// extensions bind to the SDK's unified Windows.winmd, which plain Windows lacks).
static class WinRtAwait
{
    public static TaskAwaiter<T> GetAwaiter<T>(this IAsyncOperation<T> op)
    {
        var tcs = new TaskCompletionSource<T>();
        op.Completed = (info, status) =>
        {
            if (status == AsyncStatus.Completed) tcs.TrySetResult(info.GetResults());
            else if (status == AsyncStatus.Error) tcs.TrySetException(info.ErrorCode);
            else tcs.TrySetCanceled();
        };
        return tcs.Task.GetAwaiter();
    }
}

static class Program
{
    static readonly Guid SVC = new Guid("7e1a0000-3c5e-4b8f-9d2a-574154434852");
    static readonly Guid EVT = new Guid("7e1a0001-3c5e-4b8f-9d2a-574154434852");
    static readonly Guid AUDIO = new Guid("7e1a0002-3c5e-4b8f-9d2a-574154434852");
    static readonly Guid CTRL = new Guid("7e1a0003-3c5e-4b8f-9d2a-574154434852");
    static readonly Guid INFO = new Guid("7e1a0004-3c5e-4b8f-9d2a-574154434852");
    const string NAME_PREFIX = "Watcher AI";

    static readonly object OutLock = new object();
    static readonly Dictionary<string, Link> Links = new Dictionary<string, Link>(); // by device id

    public static void Emit(string line)
    {
        lock (OutLock)
        {
            Console.Out.Write(line + "\n");
            Console.Out.Flush();
        }
    }

    public static void Log(string text) { Emit("LOG " + text.Replace('\n', ' ')); }

    static byte[] Bytes(IBuffer buffer)
    {
        byte[] data;
        CryptographicBuffer.CopyToByteArray(buffer, out data);
        return data ?? new byte[0];
    }

    public static string Hex(byte[] data)
    {
        var sb = new StringBuilder(data.Length * 2);
        foreach (var b in data) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    static byte[] Unhex(string hex)
    {
        if (hex.Length % 2 != 0) throw new FormatException("odd hex");
        var data = new byte[hex.Length / 2];
        for (int i = 0; i < data.Length; i++) data[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
        return data;
    }

    public static string FormatAddress(ulong a)
    {
        var parts = new string[6];
        for (int i = 0; i < 6; i++) parts[i] = ((a >> (40 - 8 * i)) & 0xff).ToString("X2");
        return string.Join(":", parts);
    }

    static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);

        var watcher = DeviceInformation.CreateWatcher(BluetoothLEDevice.GetDeviceSelectorFromPairingState(true));
        watcher.Added += (s, info) => OnAdded(info.Id, info.Name);
        watcher.Updated += (s, update) => { };
        watcher.Removed += (s, update) => OnRemoved(update.Id);
        watcher.Start();

        // Safety net: re-check every link (missed status events, failed setups).
        var timer = new Timer(_ =>
        {
            Link[] all;
            lock (Links) all = Links.Values.ToArray();
            foreach (var l in all) l.Kick();
        }, null, 5000, 5000);

        Emit("READY");
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line == "QUIT") break;
            if (line.StartsWith("W "))
            {
                var parts = line.Split(' ');
                if (parts.Length != 3) continue;
                byte[] data;
                try { data = Unhex(parts[2]); }
                catch { Emit("WERR " + parts[1] + " args"); continue; }
                Link[] all;
                lock (Links) all = Links.Values.ToArray();
                foreach (var l in all)
                    if (parts[1] == "*" || parts[1] == l.Address) l.Write(data);
            }
        }

        timer.Dispose();
        try { watcher.Stop(); } catch { }
        Link[] links;
        lock (Links) links = Links.Values.ToArray();
        foreach (var l in links) l.Close();
    }

    static void OnAdded(string id, string name)
    {
        if (name == null || !name.StartsWith(NAME_PREFIX)) return;
        Link link;
        lock (Links)
        {
            if (Links.ContainsKey(id)) return;
            link = new Link(id, name);
            Links[id] = link;
        }
        link.Open();
    }

    static void OnRemoved(string id)
    {
        Link link;
        lock (Links)
        {
            if (!Links.TryGetValue(id, out link)) return;
            Links.Remove(id);
        }
        link.Close();
        if (link.Address != null) Emit("UNPAIRED " + link.Address);
    }

    class Link
    {
        readonly string id;
        readonly string name;
        public string Address;
        BluetoothLEDevice dev;
        GattSession session;
        GattDeviceService service;
        GattCharacteristic evt, audio, ctrl;
        bool ready, closed;
        string step = "";
        readonly SemaphoreSlim gate = new SemaphoreSlim(1, 1);
        readonly object writeLock = new object();
        Task writeChain = Task.FromResult(0);

        public Link(string id, string name)
        {
            this.id = id;
            this.name = name;
        }

        public async void Open()
        {
            try
            {
                dev = await BluetoothLEDevice.FromIdAsync(id);
                if (dev == null) { Log("open failed: " + name); return; }
                Address = FormatAddress(dev.BluetoothAddress);
                Emit("PAIRED " + Address + " " + name);
                dev.ConnectionStatusChanged += (s, e) => { Log("link " + Address + " " + dev.ConnectionStatus); Kick(); };
                session = await GattSession.FromDeviceIdAsync(dev.BluetoothDeviceId);
                session.SessionStatusChanged += (s, e) => Kick();
                session.MaintainConnection = true; // Windows reconnects whenever the Watcher advertises
                Kick();
            }
            catch (Exception ex)
            {
                Log("open " + name + ": " + ex.Message);
            }
        }

        public void Kick()
        {
            if (dev == null || closed) return;
            Task.Run(new Func<Task>(Sync));
        }

        async Task Sync()
        {
            if (!await gate.WaitAsync(0)) return; // a sync is already running; the timer retries
            try
            {
                if (closed || dev == null) return;
                bool connected = dev.ConnectionStatus == BluetoothConnectionStatus.Connected
                    && session != null && session.SessionStatus == GattSessionStatus.Active;
                if (connected && !ready) await Setup();
                else if (!connected && ready) Teardown();
                else if (!connected && session != null && !session.MaintainConnection) session.MaintainConnection = true;
            }
            catch (Exception ex)
            {
                Log("sync " + Address + " (" + step + "): " + ex.Message);
                Teardown();
            }
            finally
            {
                gate.Release();
            }
        }

        async Task Setup()
        {
            step = "services";
            var sr = await dev.GetGattServicesAsync(BluetoothCacheMode.Uncached);
            var found = sr.Status == GattCommunicationStatus.Success
                ? sr.Services.FirstOrDefault(s => s.Uuid == SVC)
                : null;
            if (found == null)
            {
                Log("services " + Address + ": " + sr.Status);
                return;
            }
            DisposeService();
            service = found;
            step = "characteristics";
            evt = await Char(EVT);
            audio = await Char(AUDIO);
            ctrl = await Char(CTRL);
            var info = await Char(INFO);
            if (evt == null || ctrl == null) { Log("characteristics missing " + Address); DisposeService(); return; }

            // Read the encrypted Info characteristic first: it makes Windows encrypt the
            // link. Subscribing before that is undone when NimBLE restores the bond's
            // stored CCCD state on encryption, and the Watcher never becomes ready.
            step = "info";
            string infoHex = "-";
            if (info != null)
            {
                var r = await info.ReadValueAsync(BluetoothCacheMode.Uncached);
                if (r.Status != GattCommunicationStatus.Success)
                {
                    Log("info " + Address + ": " + r.Status);
                    DisposeService();
                    return;
                }
                infoHex = Hex(Bytes(r.Value));
            }

            step = "subscribe";
            evt.ValueChanged += OnEvent;
            if (audio != null) audio.ValueChanged += OnAudio;
            var st = await evt.WriteClientCharacteristicConfigurationDescriptorAsync(
                GattClientCharacteristicConfigurationDescriptorValue.Notify);
            if (st != GattCommunicationStatus.Success)
            {
                // Typically "AccessDenied" / "ProtocolError": link not authenticated (bond lost).
                Log("subscribe events " + Address + ": " + st);
                DisposeService();
                return;
            }
            if (audio != null)
                await audio.WriteClientCharacteristicConfigurationDescriptorAsync(
                    GattClientCharacteristicConfigurationDescriptorValue.Notify);


            ready = true;
            Emit("CONN " + Address + " " + session.MaxPduSize + " " + infoHex);
        }

        async Task<GattCharacteristic> Char(Guid uuid)
        {
            var r = await service.GetCharacteristicsForUuidAsync(uuid, BluetoothCacheMode.Uncached);
            return r.Status == GattCommunicationStatus.Success && r.Characteristics.Count > 0
                ? r.Characteristics[0]
                : null;
        }

        void OnEvent(GattCharacteristic c, GattValueChangedEventArgs e)
        {
            Emit("EVT " + Address + " " + Hex(Bytes(e.CharacteristicValue)));
        }

        void OnAudio(GattCharacteristic c, GattValueChangedEventArgs e)
        {
            Emit("AUDIO " + Address + " " + Hex(Bytes(e.CharacteristicValue)));
        }

        void DisposeService()
        {
            if (evt != null) evt.ValueChanged -= OnEvent;
            if (audio != null) audio.ValueChanged -= OnAudio;
            evt = audio = ctrl = null;
            if (service != null)
            {
                try { service.Dispose(); } catch { }
                service = null;
            }
        }

        void Teardown()
        {
            bool was = ready;
            ready = false;
            DisposeService();
            if (was) Emit("DISC " + Address);
        }

        public void Write(byte[] data)
        {
            lock (writeLock)
            {
                writeChain = writeChain.ContinueWith(_ => DoWrite(data)).Unwrap();
            }
        }

        async Task DoWrite(byte[] data)
        {
            var c = ctrl;
            if (!ready || c == null) { Emit("WERR " + Address + " offline"); return; }
            try
            {
                var r = await c.WriteValueWithResultAsync(CryptographicBuffer.CreateFromByteArray(data), GattWriteOption.WriteWithResponse);
                if (r.Status != GattCommunicationStatus.Success) Emit("WERR " + Address + " " + r.Status);
            }
            catch (Exception ex)
            {
                Emit("WERR " + Address + " " + ex.GetType().Name);
            }
        }

        public void Close()
        {
            closed = true;
            try
            {
                Teardown();
                if (session != null) { session.MaintainConnection = false; session.Dispose(); }
                if (dev != null) dev.Dispose();
            }
            catch { }
            session = null;
            dev = null;
        }
    }
}
