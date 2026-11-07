using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.IO;

internal static class Program
{
    static readonly object outputGate=new();
    public static void Emit(object value){lock(outputGate)Console.WriteLine(JsonSerializer.Serialize(value,options));}
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetActiveWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint source,uint target,bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
    [StructLayout(LayoutKind.Sequential)] struct RECT{public int left,top,right,bottom;}
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
    delegate bool EnumProc(IntPtr h, IntPtr param);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT key; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    record WindowInfo(string id, string title, string process, uint pid);
    static IntPtr lastExternal;
    static readonly HashSet<int> excluded = new();
    static readonly JsonSerializerOptions options = new() { PropertyNamingPolicy=JsonNamingPolicy.CamelCase };

    [STAThread] static void Main(string[] args)
    {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        Console.InputEncoding=Encoding.UTF8; Console.OutputEncoding=new UTF8Encoding(false);
        if(args.Contains("--test-window")){TestWindow();return;}
        if(args.Contains("--focus-check")){FocusCheck();return;}
        string? line;
        while((line=Console.ReadLine())!=null)
        {
            long id=0;
            try
            {
                using var doc=JsonDocument.Parse(line);
                var r=doc.RootElement; id=r.GetProperty("id").GetInt64();
                var cmd=r.GetProperty("command").GetString();
                var p=r.TryGetProperty("params",out var pp)?pp:default;
                object result=cmd switch
                {
                    "configure" => Configure(p), "capture" => Capture(p), "windows" => Windows(),
                    "target-info" => Info(Target()),
                    "input-watch" => InputObserver.Configure(p,Emit), "focus-probe" => FocusProbe.Get(),
                    "wispr-recording" => AudioActivity.WisprRecording(),
                    "audio-unmute" => AudioDucker.Unmute(),
                    "focus-own" => FocusOwn(p),
                    "audio-duck" => AudioDucker.Begin(), "audio-restore" => AudioDucker.End(), "audio-heartbeat" => AudioDucker.Heartbeat(), "audio-state" => AudioDucker.State(),
                    "action" => Action(p), "monitors" => Screen.AllScreens.Select((s,i)=>new {index=i,name=s.DeviceName,primary=s.Primary,x=s.Bounds.X,y=s.Bounds.Y,width=s.Bounds.Width,height=s.Bounds.Height}).ToArray(),
                    _ => throw new Exception("Unknown command")
                };
                Emit(new {id,result});
            }
            catch(Exception e) { Emit(new {id,error=e.Message,detail=e.StackTrace}); }
        }
        InputObserver.Stop();
    }
    static void FocusCheck()
    {
        var previous=GetForegroundWindow();
        using var form=new Form {Text="Companion focus verification",Width=480,Height=220,StartPosition=FormStartPosition.CenterScreen};
        var editor=new TextBox{Location=new Point(20,25),Width=420};
        var button=new Button{Text="Non-editable surface",Location=new Point(20,80),Width=220,Height=45};
        form.Controls.AddRange(new Control[]{editor,button});
        form.Shown+=async(_,_)=>{
            uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out _),ownThread=GetCurrentThreadId();
            AttachThreadInput(ownThread,foregroundThread,true);ShowWindow(form.Handle,5);SetForegroundWindow(form.Handle);form.Activate();editor.Select();editor.Focus();AttachThreadInput(ownThread,foregroundThread,false);await Task.Delay(250);
            var editable=await Task.Run(FocusProbe.Get);var debug=await Task.Run(()=>{var n=System.Windows.Automation.AutomationElement.FocusedElement;return new{type=n?.Current.ControlType.ProgrammaticName,pid=n?.Current.ProcessId,editorFocused=editor.Focused};});button.Focus();await Task.Delay(250);var surface=await Task.Run(FocusProbe.Get);
            var a=JsonSerializer.SerializeToElement(editable,options);var b=JsonSerializer.SerializeToElement(surface,options);
            bool ok=a.GetProperty("editable").ValueKind==JsonValueKind.True&&b.GetProperty("editable").ValueKind==JsonValueKind.False;
            Emit(new{focusCheck=ok,editor=editable,surface,debug,windowId=form.Handle.ToInt64().ToString()});Environment.ExitCode=ok?0:1;form.Close();
        };
        Application.Run(form);SetForegroundWindow(previous);
    }
    static void TestWindow()
    {
        var previous=GetForegroundWindow();
        using var form=new Form {Text="Screen Companion input verification",Width=1120,Height=720,StartPosition=FormStartPosition.CenterScreen,BackColor=Color.FromArgb(18,26,37),ForeColor=Color.White,Font=new Font("Segoe UI",24)};
        var heading=new Label{Text="Screen Companion input verification",AutoSize=true,Location=new Point(50,50)};
        var status=new Label{Text="Click count: 0",AutoSize=true,Location=new Point(50,140)};int count=0;
        var button=new Button{Text="Increment",Location=new Point(50,230),Size=new Size(360,100),BackColor=Color.FromArgb(158,230,196),ForeColor=Color.Black};
        button.Click+=(_,_)=>{status.Text="Click count: "+(++count);Console.WriteLine(JsonSerializer.Serialize(new{eventName="click",count}));};
        var textbox=new TextBox{Location=new Point(50,390),Width=960,PlaceholderText="Keyboard verification area"};
        textbox.TextChanged+=(_,_)=>Console.WriteLine(JsonSerializer.Serialize(new{eventName="text",text=textbox.Text}));
        form.Controls.AddRange(new Control[]{heading,status,button,textbox});
        var timer=new System.Windows.Forms.Timer{Interval=90000};timer.Tick+=(_,_)=>form.Close();timer.Start();
        form.Shown+=(_,_)=>{ShowWindow(form.Handle,5);SetForegroundWindow(form.Handle);form.Activate();Console.WriteLine(JsonSerializer.Serialize(new{eventName="ready",windowId=form.Handle.ToInt64().ToString()}));};
        Application.Run(form);timer.Dispose();SetForegroundWindow(previous);
    }
    static object Configure(JsonElement p) { if(p.TryGetProperty("excludePids",out var list)) foreach(var v in list.EnumerateArray()) excluded.Add(v.GetInt32()); return new {ok=true}; }
    static object FocusOwn(JsonElement p)
    {
        var target=new IntPtr(long.Parse(S(p,"windowId")));uint targetThread=GetWindowThreadProcessId(target,out var pid);
        if(!excluded.Contains((int)pid))throw new Exception("Only companion windows can receive focus through this command");
        ShowWindow(target,5);ActivateWindow(target);return new {focused=GetForegroundWindow()==target};
    }
    static void ActivateWindow(IntPtr target)
    {
        uint targetThread=GetWindowThreadProcessId(target,out _),current=GetCurrentThreadId(),foreground=GetWindowThreadProcessId(GetForegroundWindow(),out _);
        bool attached=current!=foreground&&AttachThreadInput(current,foreground,true);
        bool attachedTarget=current!=targetThread&&targetThread!=foreground&&AttachThreadInput(current,targetThread,true);
        try{BringWindowToTop(target);SetForegroundWindow(target);SetActiveWindow(target);SetFocus(target);}finally{if(attachedTarget)AttachThreadInput(current,targetThread,false);if(attached)AttachThreadInput(current,foreground,false);}
    }
    static string S(JsonElement p,string key,string fallback="") => p.ValueKind==JsonValueKind.Object&&p.TryGetProperty(key,out var v)&&v.ValueKind==JsonValueKind.String?v.GetString()??fallback:fallback;
    static int N(JsonElement p,string key,int fallback=0) => p.ValueKind==JsonValueKind.Object&&p.TryGetProperty(key,out var v)&&v.TryGetInt32(out var n)?n:fallback;
    static WindowInfo Info(IntPtr h)
    {
        var title=new StringBuilder(1024); GetWindowText(h,title,title.Capacity); GetWindowThreadProcessId(h,out uint pid);
        string process=""; try {process=Process.GetProcessById((int)pid).ProcessName;}catch{}
        return new(h.ToInt64().ToString(),title.ToString(),process,pid);
    }
    static WindowInfo[] Windows()
    {
        var list=new List<WindowInfo>();
        EnumWindows((h,p)=>{ if(IsWindowVisible(h)) {var w=Info(h);if(w.title.Length>0&&!excluded.Contains((int)w.pid))list.Add(w);}return true;},IntPtr.Zero);
        return list.ToArray();
    }
    static IntPtr Target()
    {
        var h=GetForegroundWindow(); var w=Info(h);
        bool usable(IntPtr handle,int width=200,int height=120)=>handle!=IntPtr.Zero&&IsWindow(handle)&&IsWindowVisible(handle)&&!IsIconic(handle)&&GetWindowRect(handle,out var r)&&r.right-r.left>=width&&r.bottom-r.top>=height;
        if(usable(h)&&!excluded.Contains((int)w.pid)&&w.pid>0) lastExternal=h;
        if(usable(lastExternal))return lastExternal;
        var next=Windows().FirstOrDefault(w=>usable(new IntPtr(long.Parse(w.id)),400,250));
        lastExternal=next!=null?new IntPtr(long.Parse(next.id)):h;return lastExternal;
    }
    static object Capture(JsonElement p)
    {
        var target=Target(); int index=N(p,"monitor",-1);
        var screen=index>=0&&index<Screen.AllScreens.Length?Screen.AllScreens[index]:Screen.FromHandle(target);
        var b=screen.Bounds;Bitmap full;string captureSource="monitor";
        bool useWindow=S(p,"mode","window")=="window"&&GetWindowRect(target,out var wr)&&!IsIconic(target);
        GetWindowRect(target,out var windowRect);
        if(useWindow&&windowRect.right-windowRect.left>80&&windowRect.bottom-windowRect.top>80&&windowRect.right-windowRect.left<=10000&&windowRect.bottom-windowRect.top<=10000){
            b=Rectangle.FromLTRB(windowRect.left,windowRect.top,windowRect.right,windowRect.bottom);full=new Bitmap(b.Width,b.Height,PixelFormat.Format24bppRgb);
            bool ok;using(var g=Graphics.FromImage(full)){var dc=g.GetHdc();try{ok=PrintWindow(target,dc,2);}finally{g.ReleaseHdc(dc);}}
            long brightness=0;for(int y=0;y<8;y++)for(int x=0;x<8;x++){var c=full.GetPixel((x*b.Width)/8,(y*b.Height)/8);brightness+=c.R+c.G+c.B;}
            if(ok&&brightness>128)captureSource="window";
            else{full.Dispose();b=screen.Bounds;full=new Bitmap(b.Width,b.Height,PixelFormat.Format24bppRgb);using var g=Graphics.FromImage(full);g.CopyFromScreen(b.Location,Point.Empty,b.Size,CopyPixelOperation.SourceCopy);captureSource="monitor-fallback";}
        }else{full=new Bitmap(b.Width,b.Height,PixelFormat.Format24bppRgb);using var g=Graphics.FromImage(full);g.CopyFromScreen(b.Location,Point.Empty,b.Size,CopyPixelOperation.SourceCopy);}
        if(p.TryGetProperty("region",out var region)){
            var wanted=new Rectangle(N(region,"x"),N(region,"y"),N(region,"width"),N(region,"height"));var clipped=Rectangle.Intersect(b,wanted);
            if(clipped.Width<16||clipped.Height<16){full.Dispose();throw new Exception("Zoom region is outside the captured screen");}
            var cropped=full.Clone(new Rectangle(clipped.X-b.X,clipped.Y-b.Y,clipped.Width,clipped.Height),PixelFormat.Format24bppRgb);full.Dispose();full=cropped;b=clipped;
        }
        using var captured=full;
        var scale=Math.Min(1.0,Math.Clamp(N(p,"maxWidth",2560),640,3840)/(double)b.Width); int width=(int)Math.Round(b.Width*scale),height=(int)Math.Round(b.Height*scale);
        using var image=new Bitmap(width,height);
        using(var g=Graphics.FromImage(image)){g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.DrawImage(full,0,0,width,height);}
        using var ms=new MemoryStream();
        var codec=ImageCodecInfo.GetImageEncoders().First(c=>c.FormatID==ImageFormat.Jpeg.Guid);
        using var enc=new EncoderParameters(1);enc.Param[0]=new EncoderParameter(System.Drawing.Imaging.Encoder.Quality,75L);image.Save(ms,codec,enc);
        using var tiny=new Bitmap(full,new Size(64,36));var pixels=new byte[64*36];
        for(int y=0;y<36;y++)for(int x=0;x<64;x++){var c=tiny.GetPixel(x,y);pixels[y*64+x]=(byte)((c.R*3+c.G*6+c.B)/10);}
        GetCursorPos(out var cursor);
        return new {image=Convert.ToBase64String(ms.ToArray()),width,height,bounds=new{x=b.X,y=b.Y,width=b.Width,height=b.Height},captureSource,fingerprint=Convert.ToBase64String(pixels),cursor=new{x=(int)((cursor.X-b.X)*scale),y=(int)((cursor.Y-b.Y)*scale)},window=Info(target),capturedAt=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};
    }
    static void Inject(params INPUT[] inputs) { if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf<INPUT>())!=inputs.Length)throw new Exception("Windows blocked input. The target may be elevated or the desktop locked."); }
    static INPUT K(ushort vk,bool up=false) => new(){type=1,u=new(){key=new(){vk=vk,flags=up?2u:0u}}};
    static ushort KeyCode(string key) => key.ToLowerInvariant() switch
    {
        "ctrl" or "control" => 0x11,"alt"=>0x12,"shift"=>0x10,"enter" or "return"=>0x0D,"tab"=>0x09,"escape" or "esc"=>0x1B,
        "space"=>0x20,"win" or "windows"=>0x5B,"backspace"=>0x08,"delete"=>0x2E,"up"=>0x26,"down"=>0x28,"left"=>0x25,"right"=>0x27,
        "home"=>0x24,"end"=>0x23,"pageup"=>0x21,"pagedown"=>0x22,
        _ when key.Length==1&&char.IsAsciiLetterOrDigit(key[0]) => (ushort)char.ToUpperInvariant(key[0]),
        _ when key.StartsWith("F",StringComparison.OrdinalIgnoreCase)&&int.TryParse(key[1..],out int n)&&n>=1&&n<=12 => (ushort)(0x6F+n),
        _=>throw new Exception("Unsupported keyboard key: "+key)
    };
    static object Action(JsonElement p)
    {
        string kind=S(p,"kind");
        if(kind=="focus")
        {
            string query=S(p,"query");
            var list=Windows();var found=list.FirstOrDefault(w=>w.id==query)??list.FirstOrDefault(w=>w.process.Equals(query,StringComparison.OrdinalIgnoreCase))??list.FirstOrDefault(w=>w.title.Contains(query,StringComparison.OrdinalIgnoreCase));
            if(found==null)throw new Exception("No matching open window");
            var h=new IntPtr(long.Parse(found.id));if(IsIconic(h))ShowWindow(h,9);ActivateWindow(h);Thread.Sleep(80);
            if(GetForegroundWindow()!=h)throw new Exception("Could not focus the requested window");lastExternal=h;return new{ok=true,window=found};
        }
        var target=Target();var info=Info(target); string expected=S(p,"windowId");
        if(expected.Length>0&&info.id!=expected)throw new Exception("The foreground window changed. Observe again before acting.");
        if(excluded.Contains((int)info.pid))throw new Exception("Choose a target application first");
        if(GetForegroundWindow()!=target){ActivateWindow(target);Thread.Sleep(70);if(GetForegroundWindow()!=target)throw new Exception("Could not activate target application");}
        if(kind=="key")
        {
            var keys=S(p,"key").Split('+',StringSplitOptions.TrimEntries).Select(KeyCode).ToArray();if(keys.Length==0||keys.Length>4)throw new Exception("Invalid keyboard chord");
            Inject(keys.Select(k=>K(k)).Concat(keys.Reverse().Select(k=>K(k,true))).ToArray());
        }
        else if(kind=="type")
        {
            string text=S(p,"text");if(text.Length>8000)throw new Exception("Text is too long");
            var inputs=new INPUT[text.Length*2];for(int i=0;i<text.Length;i++){inputs[i*2]=new INPUT{type=1,u=new(){key=new(){scan=text[i],flags=4}}};inputs[i*2+1]=new INPUT{type=1,u=new(){key=new(){scan=text[i],flags=6}}};}if(inputs.Length>0)Inject(inputs);Thread.Sleep(40);
        }
        else if(kind=="click"||kind=="doubleclick"||kind=="rightclick")
        {
            SetCursorPos(N(p,"screenX"),N(p,"screenY"));uint down=kind=="rightclick"?8u:2u,up=kind=="rightclick"?16u:4u;
            int count=kind=="doubleclick"?2:1;for(int i=0;i<count;i++){Inject(new INPUT{u=new(){mouse=new(){flags=down}}},new INPUT{u=new(){mouse=new(){flags=up}}});if(count==2)Thread.Sleep(70);}
        }
        else if(kind=="scroll")
        {
            if(p.TryGetProperty("screenX",out _))SetCursorPos(N(p,"screenX"),N(p,"screenY"));
            int delta=Math.Clamp(N(p,"delta",-480),-2400,2400);Inject(new INPUT{u=new(){mouse=new(){flags=0x800,data=unchecked((uint)delta)}}});
        }
        else throw new Exception("Unsupported action: "+kind);
        return new{ok=true,window=info};
    }
}
