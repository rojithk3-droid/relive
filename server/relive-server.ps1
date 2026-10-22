# ReLive world server.
# Serves the client (static files) and runs the shared, persistent world over WebSockets:
# players, building objects, land plots, terrain edits and chat. The server is the authority for
# ownership: it refuses edits on land or objects that belong to someone else.
# No Node, no Python: HttpListener + WebSockets via inline C#, Windows PowerShell 5.1+.
#
#   powershell -ExecutionPolicy Bypass -File relive\server\relive-server.ps1            (this PC only)
#   powershell -ExecutionPolicy Bypass -File relive\server\relive-server.ps1 -Lan       (whole LAN, run as admin once)
#
# LAN mode binds http://+:PORT/ which Windows only allows for admins, or after a one-time:
#   netsh http add urlacl url=http://+:8799/ user=Everyone
# and a firewall rule for the port. Friends then open http://<your-ip>:8799/
# The world is saved to relive\data\world.txt every few seconds.
param(
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 8799 }),
  [switch]$Lan,
  [switch]$Open
)

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$gameUrl = "http://localhost:$Port/"

# already running (e.g. a second double-click)? just open the game
try {
  $s = Invoke-WebRequest -Uri ($gameUrl + 'status') -UseBasicParsing -TimeoutSec 2
  if ($s.Content -like '*"server":"relive"*') {
    Write-Host "ReLive is already running on $gameUrl"
    if ($Open) { Start-Process $gameUrl }
    exit 0
  }
} catch { }

$code = @"
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public class RlClient {
  public int Id;
  public string Uid = "";
  public string Profile = "{}";
  public string State = "";
  public bool Hello;
  public WebSocket Ws;
  public SemaphoreSlim SendLock = new SemaphoreSlim(1, 1);
  public volatile bool Alive = true;
  public DateTime ChatWindow = DateTime.UtcNow;
  public int ChatCount;
}

public class RlObj { public string Owner; public double X, Z; public string Json; }
public class RlPlot { public string Owner; public bool Open; public string Json; }

public class RlServer {
  const double PLOT = 32.0;
  const int MAX_PLOTS = 6;
  const int MAX_OBJECTS_PER_USER = 30000;
  const int MAX_TERRAIN_OPS = 200000;

  string root, dataDir, dataFile;
  HttpListener listener;
  int nextId = 1;
  readonly object gate = new object();
  List<RlClient> clients = new List<RlClient>();
  Dictionary<string, RlObj> objects = new Dictionary<string, RlObj>();
  Dictionary<string, RlPlot> plots = new Dictionary<string, RlPlot>();
  Dictionary<string, int> objCount = new Dictionary<string, int>();
  List<string> terrain = new List<string>();
  List<string> chat = new List<string>();
  List<string> notes = new List<string>();
  // the starter town (centre and radius, metres) belongs to everyone: no building or digging inside it
  const double TOWN_X = 0, TOWN_Z = 40, TOWN_R = 46;
  long epoch;
  bool dirty;
  static readonly CultureInfo IC = CultureInfo.InvariantCulture;

  Dictionary<string, string> mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
    {".html","text/html; charset=utf-8"}, {".css","text/css; charset=utf-8"}, {".js","text/javascript; charset=utf-8"},
    {".mjs","text/javascript; charset=utf-8"}, {".json","application/json"}, {".png","image/png"}, {".jpg","image/jpeg"},
    {".jpeg","image/jpeg"}, {".svg","image/svg+xml"}, {".ico","image/x-icon"}, {".glb","model/gltf-binary"},
    {".gltf","model/gltf+json"}, {".hdr","application/octet-stream"}, {".mp3","audio/mpeg"}, {".ogg","audio/ogg"},
    {".wav","audio/wav"}, {".woff2","font/woff2"}, {".md","text/plain; charset=utf-8"}
  };

  public RlServer(string rootDir) {
    root = rootDir;
    dataDir = Path.Combine(root, "data");
    dataFile = Path.Combine(dataDir, "world.txt");
    Directory.CreateDirectory(dataDir);
    Load();
    if (epoch == 0) { epoch = NowMs(); dirty = true; }
  }

  static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
  static string PlotKey(double x, double z) { return ((int)Math.Floor(x / PLOT)).ToString(IC) + "," + ((int)Math.Floor(z / PLOT)).ToString(IC); }
  static double Num(string s) { double d; return double.TryParse(s, NumberStyles.Float, IC, out d) && !double.IsNaN(d) && !double.IsInfinity(d) ? d : 0; }
  static string F(double d) { return d.ToString("0.###", IC); }

  public int ClientCount { get { lock (gate) { return clients.Count; } } }

  // ------------------------------------------------------------------ persistence
  void Load() {
    if (!File.Exists(dataFile)) return;
    foreach (string line in File.ReadAllLines(dataFile, Encoding.UTF8)) {
      if (line.Length < 3) continue;
      string[] p = line.Substring(2).Split('\t');
      try {
        switch (line[0]) {
          case 'M': epoch = long.Parse(p[0], IC); break;
          case 'O': if (p.Length >= 5) { RlObj o = new RlObj(); o.Owner = p[1]; o.X = Num(p[2]); o.Z = Num(p[3]); o.Json = p[4]; objects[p[0]] = o; Count(o.Owner, 1); } break;
          case 'L': if (p.Length >= 4) { RlPlot pl = new RlPlot(); pl.Owner = p[1]; pl.Open = p[2] == "1"; pl.Json = p[3]; plots[p[0]] = pl; } break;
          case 'T': terrain.Add(line.Substring(2)); break;
          case 'C': chat.Add(line); break;
          case 'K': notes.Add(line); break;
        }
      } catch { }
    }
    Console.WriteLine("Loaded world: " + objects.Count + " objects, " + plots.Count + " plots, " + terrain.Count + " terrain edits");
  }

  public void SaveIfDirty() {
    StringBuilder sb;
    lock (gate) {
      if (!dirty) return;
      dirty = false;
      sb = new StringBuilder();
      sb.Append("M ").Append(epoch.ToString(IC)).Append('\n');
      foreach (KeyValuePair<string, RlPlot> kv in plots) sb.Append("L ").Append(kv.Key).Append('\t').Append(kv.Value.Owner).Append('\t').Append(kv.Value.Open ? "1" : "0").Append('\t').Append(kv.Value.Json).Append('\n');
      foreach (string t in terrain) sb.Append("T ").Append(t).Append('\n');
      foreach (KeyValuePair<string, RlObj> kv in objects) sb.Append("O ").Append(kv.Key).Append('\t').Append(kv.Value.Owner).Append('\t').Append(F(kv.Value.X)).Append('\t').Append(F(kv.Value.Z)).Append('\t').Append(kv.Value.Json).Append('\n');
      foreach (string c in chat) sb.Append(c).Append('\n');
      foreach (string k in notes) sb.Append(k).Append('\n');
    }
    try {
      string tmp = dataFile + ".tmp";
      File.WriteAllText(tmp, sb.ToString(), new UTF8Encoding(false));
      if (File.Exists(dataFile)) File.Replace(tmp, dataFile, null); else File.Move(tmp, dataFile);
    } catch (Exception e) { Console.WriteLine("save failed: " + e.Message); lock (gate) { dirty = true; } }
  }

  void Count(string uid, int d) { int n; objCount.TryGetValue(uid, out n); objCount[uid] = n + d; }

  // ------------------------------------------------------------------ http
  public void Start(string prefix) {
    listener = new HttpListener();
    listener.Prefixes.Add(prefix);
    listener.Start();
    Task.Run(() => AcceptLoop());
  }

  async Task AcceptLoop() {
    while (listener.IsListening) {
      HttpListenerContext ctx = null;
      try { ctx = await listener.GetContextAsync(); } catch { if (!listener.IsListening) return; continue; }
      HttpListenerContext c = ctx;
      Task handler = Task.Run(() => Handle(c));
    }
  }

  async Task Handle(HttpListenerContext ctx) {
    try {
      string path = ctx.Request.Url.AbsolutePath;
      if (ctx.Request.IsWebSocketRequest && path == "/ws") { await HandleSocket(ctx); return; }
      if (path == "/status") {
        int n, o, pl;
        lock (gate) { n = clients.Count; o = objects.Count; pl = plots.Count; }
        WriteText(ctx.Response, "{\"server\":\"relive\",\"players\":" + n + ",\"objects\":" + o + ",\"plots\":" + pl + "}", "application/json");
        return;
      }
      if (path == "/") path = "/index.html";
      string rel = Uri.UnescapeDataString(path.TrimStart('/')).Replace('/', Path.DirectorySeparatorChar);
      string full = Path.GetFullPath(Path.Combine(root, rel));
      bool inData = full.StartsWith(Path.GetFullPath(dataDir), StringComparison.OrdinalIgnoreCase);
      if (inData || !full.StartsWith(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase) || !File.Exists(full)) {
        ctx.Response.StatusCode = 404;
        WriteText(ctx.Response, "Not found: " + path, "text/plain");
        return;
      }
      string ct;
      if (!mime.TryGetValue(Path.GetExtension(full), out ct)) ct = "application/octet-stream";
      byte[] bytes = File.ReadAllBytes(full);
      ctx.Response.ContentType = ct;
      ctx.Response.Headers["Cache-Control"] = "no-cache";
      ctx.Response.ContentLength64 = bytes.Length;
      if (ctx.Request.HttpMethod != "HEAD") await ctx.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length);
      ctx.Response.OutputStream.Close();
    } catch (Exception e) {
      try { Console.WriteLine("http error: " + e.Message); ctx.Response.Abort(); } catch { }
    }
  }

  void WriteText(HttpListenerResponse res, string text, string ct) {
    byte[] b = Encoding.UTF8.GetBytes(text);
    res.ContentType = ct;
    res.ContentLength64 = b.Length;
    res.OutputStream.Write(b, 0, b.Length);
    res.OutputStream.Close();
  }

  // ------------------------------------------------------------------ sockets
  async Task HandleSocket(HttpListenerContext ctx) {
    HttpListenerWebSocketContext wctx = await ctx.AcceptWebSocketAsync(null);
    RlClient cl = new RlClient();
    cl.Ws = wctx.WebSocket;
    lock (gate) { cl.Id = nextId++; clients.Add(cl); }
    byte[] buf = new byte[65536];
    MemoryStream acc = new MemoryStream();
    try {
      while (cl.Ws.State == WebSocketState.Open) {
        WebSocketReceiveResult r = await cl.Ws.ReceiveAsync(new ArraySegment<byte>(buf), CancellationToken.None);
        if (r.MessageType == WebSocketMessageType.Close) break;
        acc.Write(buf, 0, r.Count);
        if (acc.Length > 8 * 1024 * 1024) break;
        if (!r.EndOfMessage) continue;
        string msg = Encoding.UTF8.GetString(acc.GetBuffer(), 0, (int)acc.Length);
        acc.SetLength(0);
        // a frame may carry several commands, one per line (JSON never contains raw newlines)
        foreach (string line in msg.Split('\n')) {
          if (line.Length < 1) continue;
          try { OnCommand(cl, line); } catch (Exception e) { Console.WriteLine("cmd error: " + e.Message); }
        }
      }
    } catch { }
    cl.Alive = false;
    bool wasHello;
    lock (gate) { clients.Remove(cl); wasHello = cl.Hello; }
    if (wasHello) {
      Broadcast("X " + cl.Id, null);
      Console.WriteLine("- player " + cl.Id + " left (" + ClientCount + " online)");
    }
    try { await cl.Ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None); } catch { }
  }

  // Client -> server, one command per line, tab-separated fields:
  //   H token  profile             join (the token is a private per-browser secret; the public user id is its hash)
  //   N profile                    change name / avatar
  //   P state                      own avatar state (position, heading, animation), relayed as-is
  //   O id  x  z  json             create or change an object at world position x,z
  //   D id                         delete an object
  //   T x  z  r  json              terrain brush stroke centred on x,z with radius r
  //   L plotKey  open  json        claim a plot, or update one you own (open=1 lets anyone build there)
  //   R plotKey                    release a plot you own
  //   C json                       chat to everyone
  //   W sessionId  json            private message
  //   A json                       passing interaction (door, lamp) relayed to everyone else, not stored
  //   V sessionId  json            voice-chat handshake relayed to one player
  //   K json                       note for the town notice board (stored)
  // Server -> client: Y (welcome), B (snapshot start), N, P, X (left), O, D, T, L, R, C, W, A, V, K, E (refused, reason)
  void OnCommand(RlClient cl, string line) {
    char cmd = line[0];
    string rest = line.Length > 2 ? line.Substring(2) : "";
    if (cmd == 'H') { Hello(cl, rest); return; }
    if (!cl.Hello) return;
    string[] p;
    switch (cmd) {
      case 'N':
        if (rest.Length > 4000) return;
        cl.Profile = rest;
        Broadcast("N " + cl.Id + "\t" + cl.Uid + "\t" + rest, null);
        break;
      case 'P':
        if (rest.Length > 2000) return;
        cl.State = rest;
        Broadcast("P " + cl.Id + "\t" + rest, cl);
        break;
      case 'O': {
        p = rest.Split(new char[] { '\t' }, 4);
        if (p.Length < 4 || p[0].Length == 0 || p[0].Length > 64 || p[3].Length > 20000) return;
        double x = Num(p[1]), z = Num(p[2]);
        string outMsg = null, err = null, revert = null;
        lock (gate) {
          RlObj o;
          bool exists = objects.TryGetValue(p[0], out o);
          if (exists && !CanModify(cl.Uid, o)) { err = "That belongs to someone else."; revert = ObjLine(p[0], o); }
          else if (!CanBuild(cl.Uid, x, z)) { err = "This land is someone else's plot."; revert = exists ? ObjLine(p[0], o) : "D " + p[0]; }
          else {
            if (!exists) {
              int n; objCount.TryGetValue(cl.Uid, out n);
              if (n >= MAX_OBJECTS_PER_USER) { err = "You have reached the object limit."; revert = "D " + p[0]; }
              else { o = new RlObj(); o.Owner = cl.Uid; Count(cl.Uid, 1); objects[p[0]] = o; }
            }
            if (err == null) { o.X = x; o.Z = z; o.Json = p[3]; dirty = true; outMsg = ObjLine(p[0], o); }
          }
        }
        if (err != null) Refuse(cl, err, revert); else Broadcast(outMsg, cl);
        break;
      }
      case 'D': {
        string id = rest.Trim();
        string err = null, revert = null;
        lock (gate) {
          RlObj o;
          if (!objects.TryGetValue(id, out o)) return;
          if (!CanModify(cl.Uid, o)) { err = "That belongs to someone else."; revert = ObjLine(id, o); }
          else { objects.Remove(id); Count(o.Owner, -1); dirty = true; }
        }
        if (err != null) Refuse(cl, err, revert); else Broadcast("D " + id, cl);
        break;
      }
      case 'T': {
        p = rest.Split(new char[] { '\t' }, 4);
        if (p.Length < 4 || p[3].Length > 2000) return;
        double x = Num(p[0]), z = Num(p[1]), r = Math.Min(Math.Abs(Num(p[2])), 40);
        bool ok;
        lock (gate) {
          ok = CanBuild(cl.Uid, x, z) && CanBuild(cl.Uid, x - r, z - r) && CanBuild(cl.Uid, x + r, z - r) && CanBuild(cl.Uid, x - r, z + r) && CanBuild(cl.Uid, x + r, z + r);
          if (ok && terrain.Count < MAX_TERRAIN_OPS) { terrain.Add(rest); dirty = true; } else ok = false;
        }
        if (!ok) { Refuse(cl, "You can only reshape public land or your own plots.", null); return; }
        Broadcast("T " + rest, cl);
        break;
      }
      case 'L': {
        p = rest.Split(new char[] { '\t' }, 3);
        if (p.Length < 3 || p[0].Length > 24 || p[2].Length > 1000) return;
        string err = null, outMsg = null;
        lock (gate) {
          RlPlot pl;
          if (plots.TryGetValue(p[0], out pl)) {
            if (pl.Owner != cl.Uid) err = "Someone already owns this plot.";
          } else {
            int mine = 0, pi, pj;
            foreach (RlPlot q in plots.Values) if (q.Owner == cl.Uid) mine++;
            string[] kp = p[0].Split(',');
            if (kp.Length != 2 || !int.TryParse(kp[0], out pi) || !int.TryParse(kp[1], out pj) || Math.Abs(pi * PLOT + PLOT / 2) > 512 || Math.Abs(pj * PLOT + PLOT / 2) > 512) err = "That is not a plot on the island.";
            else if (mine >= MAX_PLOTS) err = "You can own up to " + MAX_PLOTS + " plots.";
            else {
              // claiming land must not hand you control over what other people already built there
              foreach (RlObj o in objects.Values)
                if (o.Owner != cl.Uid && PlotKey(o.X, o.Z) == p[0] && o.Json.IndexOf("\"t\":\"cut\"", StringComparison.Ordinal) < 0) { err = "Someone else has already built on this plot."; break; }
              if (err == null) { pl = new RlPlot(); pl.Owner = cl.Uid; plots[p[0]] = pl; }
            }
          }
          if (err == null) {
            pl.Open = p[1] == "1"; pl.Json = p[2]; dirty = true;
            outMsg = "L " + p[0] + "\t" + pl.Owner + "\t" + (pl.Open ? "1" : "0") + "\t" + pl.Json;
          }
        }
        if (err != null) Refuse(cl, err, null); else Broadcast(outMsg, null);
        break;
      }
      case 'R': {
        string key = rest.Trim();
        bool ok = false;
        lock (gate) {
          RlPlot pl;
          if (plots.TryGetValue(key, out pl) && pl.Owner == cl.Uid) { plots.Remove(key); dirty = true; ok = true; }
        }
        if (ok) Broadcast("R " + key, null);
        break;
      }
      case 'C': {
        if (rest.Length > 2000) return;
        DateTime now = DateTime.UtcNow;
        if ((now - cl.ChatWindow).TotalSeconds > 6) { cl.ChatWindow = now; cl.ChatCount = 0; }
        if (++cl.ChatCount > 6) { Refuse(cl, "Slow down a little - too many messages.", null); return; }
        string outMsg = "C " + cl.Id + "\t" + cl.Uid + "\t" + NowMs().ToString(IC) + "\t" + rest;
        lock (gate) { chat.Add(outMsg); if (chat.Count > 150) chat.RemoveAt(0); dirty = true; }
        Broadcast(outMsg, null);
        break;
      }
      case 'A': {
        // a passing interaction (door swung, lamp switched): shown to everyone, never stored
        if (rest.Length > 1000) return;
        Broadcast("A " + cl.Id + "\t" + rest, cl);
        break;
      }
      case 'V': {
        // voice-chat handshake for one other player
        p = rest.Split(new char[] { '\t' }, 2);
        if (p.Length < 2 || p[1].Length > 12000) return;
        int vt; if (!int.TryParse(p[0], out vt)) return;
        RlClient vtarget = null;
        lock (gate) { foreach (RlClient c in clients) if (c.Id == vt && c.Hello) vtarget = c; }
        if (vtarget != null) SendTo(vtarget, "V " + cl.Id + "\t" + p[1]);
        break;
      }
      case 'K': {
        // a note pinned to the town notice board (kept, newest 60)
        if (rest.Length > 600) return;
        DateTime know = DateTime.UtcNow;
        if ((know - cl.ChatWindow).TotalSeconds > 6) { cl.ChatWindow = know; cl.ChatCount = 0; }
        if (++cl.ChatCount > 6) { Refuse(cl, "Slow down a little.", null); return; }
        string kmsg = "K " + cl.Id + "\t" + cl.Uid + "\t" + NowMs().ToString(IC) + "\t" + rest;
        lock (gate) { notes.Add(kmsg); if (notes.Count > 60) notes.RemoveAt(0); dirty = true; }
        Broadcast(kmsg, null);
        break;
      }
      case 'W': {
        p = rest.Split(new char[] { '\t' }, 2);
        if (p.Length < 2 || p[1].Length > 2000) return;
        int to; if (!int.TryParse(p[0], out to)) return;
        RlClient target = null;
        lock (gate) { foreach (RlClient c in clients) if (c.Id == to && c.Hello) target = c; }
        if (target == null) { Refuse(cl, "That player is offline.", null); return; }
        string outMsg = "W " + cl.Id + "\t" + to + "\t" + p[1];
        SendTo(target, outMsg);
        if (target != cl) SendTo(cl, outMsg);
        break;
      }
    }
  }

  void Hello(RlClient cl, string rest) {
    if (cl.Hello) return;
    string[] p = rest.Split(new char[] { '\t' }, 2);
    if (p.Length < 2 || p[0].Length < 8 || p[1].Length > 4000) return;
    cl.Uid = Hash(p[0]);
    cl.Profile = p[1];
    StringBuilder sb = new StringBuilder();
    sb.Append("Y ").Append(cl.Id).Append('\t').Append(cl.Uid).Append('\t').Append(NowMs().ToString(IC)).Append('\t').Append(epoch.ToString(IC)).Append('\n');
    sb.Append("B\n");
    lock (gate) {
      foreach (KeyValuePair<string, RlPlot> kv in plots) sb.Append("L ").Append(kv.Key).Append('\t').Append(kv.Value.Owner).Append('\t').Append(kv.Value.Open ? "1" : "0").Append('\t').Append(kv.Value.Json).Append('\n');
      foreach (string t in terrain) sb.Append("T ").Append(t).Append('\n');
      foreach (KeyValuePair<string, RlObj> kv in objects) sb.Append(ObjLine(kv.Key, kv.Value)).Append('\n');
      foreach (string c in chat) sb.Append(c).Append('\n');
      foreach (string k in notes) sb.Append(k).Append('\n');
      foreach (RlClient o in clients) {
        if (!o.Hello || o == cl) continue;
        sb.Append("N ").Append(o.Id).Append('\t').Append(o.Uid).Append('\t').Append(o.Profile).Append('\n');
        if (o.State.Length > 0) sb.Append("P ").Append(o.Id).Append('\t').Append(o.State).Append('\n');
      }
      cl.Hello = true;
    }
    sb.Append("B end");
    SendTo(cl, sb.ToString());
    Broadcast("N " + cl.Id + "\t" + cl.Uid + "\t" + cl.Profile, cl);
    Console.WriteLine("+ player " + cl.Id + " joined (" + ClientCount + " online)");
  }

  static string ObjLine(string id, RlObj o) { return "O " + id + "\t" + o.Owner + "\t" + F(o.X) + "\t" + F(o.Z) + "\t" + o.Json; }

  bool CanBuild(string uid, double x, double z) {
    if (Math.Sqrt((x - TOWN_X) * (x - TOWN_X) + (z - TOWN_Z) * (z - TOWN_Z)) < TOWN_R) return false;
    RlPlot pl;
    if (!plots.TryGetValue(PlotKey(x, z), out pl)) return true;
    return pl.Owner == uid || pl.Open;
  }

  bool CanModify(string uid, RlObj o) {
    if (o.Owner == uid) return true;
    RlPlot pl;
    return plots.TryGetValue(PlotKey(o.X, o.Z), out pl) && pl.Owner == uid;
  }

  static string Hash(string token) {
    using (SHA1 sha = SHA1.Create()) {
      byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes("relive:" + token));
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < 6; i++) sb.Append(h[i].ToString("x2"));
      return sb.ToString();
    }
  }

  void Refuse(RlClient cl, string reason, string revert) {
    SendTo(cl, "E " + reason + (revert != null ? "\n" + revert : ""));
  }

  void Broadcast(string msg, RlClient except) {
    List<RlClient> targets = new List<RlClient>();
    lock (gate) { foreach (RlClient c in clients) if (c != except && c.Hello) targets.Add(c); }
    byte[] data = Encoding.UTF8.GetBytes(msg);
    foreach (RlClient t in targets) { RlClient tt = t; Task.Run(() => Send(tt, data)); }
  }

  void SendTo(RlClient cl, string msg) {
    byte[] data = Encoding.UTF8.GetBytes(msg);
    Task.Run(() => Send(cl, data));
  }

  async Task Send(RlClient cl, byte[] data) {
    if (!cl.Alive) return;
    await cl.SendLock.WaitAsync();
    try {
      if (cl.Ws.State == WebSocketState.Open)
        await cl.Ws.SendAsync(new ArraySegment<byte>(data), WebSocketMessageType.Text, true, CancellationToken.None);
    } catch { cl.Alive = false; }
    finally { cl.SendLock.Release(); }
  }
}
"@

Add-Type -TypeDefinition $code -Language CSharp

$server = New-Object RlServer($root)
$prefix = if ($Lan) { "http://+:$Port/" } else { "http://localhost:$Port/" }
try {
  $server.Start($prefix)
} catch {
  Write-Host "Could not bind $prefix : $($_.Exception.Message)"
  if ($Lan) { Write-Host "LAN mode needs admin, or run once as admin:  netsh http add urlacl url=http://+:$Port/ user=Everyone" }
  else { Write-Host "Is another program using port $Port? Try:  -Port 8800" }
  if ($Open) { Read-Host 'Press Enter to close' }
  exit 1
}
Write-Host "RELIVE server running on $prefix  (game: $gameUrl  websocket: /ws)"
Write-Host "Keep this window open while you play. Close it to stop the server. The world saves automatically."
if ($Open) { Start-Process $gameUrl }
if ($Lan) {
  $ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | Where-Object { $_.AddressFamily -eq 'InterNetwork' }
  foreach ($ip in $ips) { Write-Host "  friends on your network: http://$($ip):$Port/" }
}
while ($true) { Start-Sleep -Seconds 3; $server.SaveIfDirty() }
