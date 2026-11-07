using System.Diagnostics;
using System.Runtime.InteropServices;

// Reads capture-session status only. Never opens an audio stream or reads samples.
internal static class AudioActivity
{
    [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator{}
    [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevices
    {
        [PreserveSig]int EnumAudioEndpoints(int flow,int mask,out IntPtr devices);
        [PreserveSig]int GetDefaultAudioEndpoint(int flow,int role,out IDevice device);
    }
    [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice
    { [PreserveSig]int Activate(ref Guid iid,int context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)]out object instance); }
    [ComImport,Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IManager
    {
        [PreserveSig]int GetAudioSessionControl(IntPtr id,uint flags,out IntPtr control);
        [PreserveSig]int GetSimpleAudioVolume(IntPtr id,uint flags,out IntPtr volume);
        [PreserveSig]int GetSessionEnumerator(out ISessions sessions);
    }
    [ComImport,Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessions
    {
        [PreserveSig]int GetCount(out int count);
        [PreserveSig]int GetSession(int index,out IControl control);
    }
    [ComImport,Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IControl
    {
        [PreserveSig]int GetState(out int state);
        [PreserveSig]int GetDisplayName(out IntPtr name);
        [PreserveSig]int SetDisplayName(IntPtr name,IntPtr context);
        [PreserveSig]int GetIconPath(out IntPtr name);
        [PreserveSig]int SetIconPath(IntPtr name,IntPtr context);
        [PreserveSig]int GetGroupingParam(out Guid id);
        [PreserveSig]int SetGroupingParam(ref Guid id,IntPtr context);
        [PreserveSig]int RegisterAudioSessionNotification(IntPtr callback);
        [PreserveSig]int UnregisterAudioSessionNotification(IntPtr callback);
        [PreserveSig]int GetSessionIdentifier(out IntPtr id);
        [PreserveSig]int GetSessionInstanceIdentifier(out IntPtr id);
        [PreserveSig]int GetProcessId(out uint id);
    }
    public static object WisprRecording()
    {
        IDevices? devices=null;IDevice? device=null;IManager? manager=null;ISessions? sessions=null;
        try{
            devices=(IDevices)new Enumerator();Marshal.ThrowExceptionForHR(devices.GetDefaultAudioEndpoint(1,1,out device));
            var id=typeof(IManager).GUID;Marshal.ThrowExceptionForHR(device.Activate(ref id,23,IntPtr.Zero,out var instance));manager=(IManager)instance;
            Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));sessions.GetCount(out var count);bool active=false;
            for(int i=0;i<count;i++){
                IControl? control=null;
                try{sessions.GetSession(i,out control);control.GetState(out var state);control.GetProcessId(out var pid);if(state==1&&pid>0){var name=Process.GetProcessById((int)pid).ProcessName;if(name.Contains("wispr",StringComparison.OrdinalIgnoreCase))active=true;}}
                catch{}finally{if(control!=null)Marshal.ReleaseComObject(control);}
            }
            return new {available=true,active};
        }catch{return new {available=false,active=false};}
        finally{if(sessions!=null)Marshal.ReleaseComObject(sessions);if(manager!=null)Marshal.ReleaseComObject(manager);if(device!=null)Marshal.ReleaseComObject(device);if(devices!=null)Marshal.ReleaseComObject(devices);}
    }
}
