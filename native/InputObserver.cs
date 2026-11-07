using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Automation;

internal static class InputObserver
{
    delegate IntPtr HookProc(int code,IntPtr message,IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id,HookProc callback,IntPtr module,uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string? module);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread,uint message,IntPtr w,IntPtr l);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] struct KeyboardData {public uint vk,scan,flags,time;public UIntPtr extra;}
    [StructLayout(LayoutKind.Sequential)] struct MouseData{public int x,y;public uint data,flags,time;public UIntPtr extra;}
    record Binding(string id,string mode,int[] keys);
    static Binding[] bindings=Array.Empty<Binding>();
    static readonly HashSet<int> pressed=new();
    static readonly HashSet<string> active=new();
    static readonly HookProc callback=OnKey;
    static readonly HookProc mouseCallback=OnMouse;
    static IntPtr hook,mouseHook;static uint threadId;static Thread? thread;static volatile bool refresh;
    static Action<object>? emit;
    static int Normalize(int key)=>key switch{162 or 163=>17,160 or 161=>16,164 or 165=>18,92=>91,_=>key};
    public static object Configure(JsonElement p,Action<object> output)
    {
        emit=output;
        var list=new List<Binding>();
        foreach(var b in p.GetProperty("bindings").EnumerateArray())
            list.Add(new Binding(b.GetProperty("id").GetString()??"",b.GetProperty("mode").GetString()??"ptt",b.GetProperty("keys").EnumerateArray().Select(k=>Normalize(k.GetInt32())).Distinct().ToArray()));
        bindings=list.ToArray();
        refresh=true;
        if(thread==null){thread=new Thread(Run){IsBackground=true};thread.SetApartmentState(ApartmentState.STA);thread.Start();}
        return new{ok=true,count=bindings.Length};
    }
    static void Run()
    {
        threadId=GetCurrentThreadId();
        hook=SetWindowsHookEx(13,callback,GetModuleHandle(null),0);
        mouseHook=SetWindowsHookEx(14,mouseCallback,GetModuleHandle(null),0);
        if(hook==IntPtr.Zero){emit?.Invoke(new{ @event="inputError",message="The keyboard observer could not start"});return;}
        FocusProbe.Warm();
        using var timer=new System.Windows.Forms.Timer{Interval=1000};timer.Tick+=(_,_)=>{if(!refresh)return;refresh=false;if(hook!=IntPtr.Zero)UnhookWindowsHookEx(hook);hook=SetWindowsHookEx(13,callback,GetModuleHandle(null),0);};timer.Start();
        System.Windows.Forms.Application.Run();
        UnhookWindowsHookEx(hook);
        if(mouseHook!=IntPtr.Zero)UnhookWindowsHookEx(mouseHook);
    }
    static IntPtr OnKey(int code,IntPtr message,IntPtr pointer)
    {
        if(code>=0){
            var data=Marshal.PtrToStructure<KeyboardData>(pointer);
            if((data.flags&0x10)==0){
                int key=Normalize((int)data.vk);bool down=message.ToInt64() is 0x100 or 0x104;
                if(down)pressed.Add(key);else pressed.Remove(key);
                if(down&&key==27)emit?.Invoke(new{@event="wisprKey",phase="cancel",mode="cancel",at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()});
                foreach(var binding in bindings){
                    bool match=binding.keys.Length>0&&binding.keys.All(pressed.Contains);
                    if(match&&active.Add(binding.id))emit?.Invoke(new{@event="wisprKey",phase=binding.mode=="toggle"?"toggle":"start",mode=binding.mode,id=binding.id,at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()});
                    else if(!match&&active.Remove(binding.id)&&binding.mode!="toggle")emit?.Invoke(new{@event="wisprKey",phase="end",mode=binding.mode,id=binding.id,at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()});
                }
            }
        }
        return CallNextHookEx(hook,code,message,pointer);
    }
    static IntPtr OnMouse(int code,IntPtr message,IntPtr pointer){if(code>=0&&message.ToInt64() is 0x201 or 0x204 or 0x207){var d=Marshal.PtrToStructure<MouseData>(pointer);if((d.flags&1)==0)emit?.Invoke(new{@event="mouseDown",x=d.x,y=d.y});}return CallNextHookEx(mouseHook,code,message,pointer);}
    public static void Stop(){if(threadId!=0)PostThreadMessage(threadId,0x12,IntPtr.Zero,IntPtr.Zero);AudioDucker.End();}
}

internal static class FocusProbe
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static readonly object gate=new();
    static (long window,bool? editable,long time) cached;
    public static void Warm(){Task.Run(()=>Get());}
    public static object Get()
    {
        long window=GetForegroundWindow().ToInt64();
        lock(gate){if(cached.window==window&&Environment.TickCount64-cached.time<180)return new{windowId=window.ToString(),editable=cached.editable};}
        var task=Task.Run(()=>{
            try{
                var element=AutomationElement.FocusedElement;if(element==null)return (bool?)null;
                if(element.Current.IsPassword)return true;
                if(element.Current.ControlType==ControlType.Edit)return true;
                if(element.TryGetCurrentPattern(ValuePattern.Pattern,out var value))return !((ValuePattern)value).Current.IsReadOnly;
                if(element.TryGetCurrentPattern(TextPattern.Pattern,out var text)){var readOnly=((TextPattern)text).DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute);if(readOnly is bool ro)return !ro;return (bool?)null;}
                return false;
            }catch{return (bool?)null;}
        });
        bool? editable=task.Wait(350)?task.Result:null;
        if(GetForegroundWindow().ToInt64()!=window)editable=null;
        lock(gate)cached=(window,editable,Environment.TickCount64);
        return new{windowId=window.ToString(),editable};
    }
}
