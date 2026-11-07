using System.Runtime.InteropServices;

internal static class AudioDucker
{
    [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator{}
    [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDeviceEnumerator
    {int EnumAudioEndpoints(int flow,int mask,out IntPtr devices);int GetDefaultAudioEndpoint(int flow,int role,out IDevice device);}
    [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice
    {int Activate(ref Guid iid,int context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)]out object instance);}
    [ComImport,Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr callback);int UnregisterControlChangeNotify(IntPtr callback);int GetChannelCount(out uint channels);
        int SetMasterVolumeLevel(float level,ref Guid context);int SetMasterVolumeLevelScalar(float level,ref Guid context);
        int GetMasterVolumeLevel(out float level);int GetMasterVolumeLevelScalar(out float level);
        int SetChannelVolumeLevel(uint channel,float level,ref Guid context);int SetChannelVolumeLevelScalar(uint channel,float level,ref Guid context);
        int GetChannelVolumeLevel(uint channel,out float level);int GetChannelVolumeLevelScalar(uint channel,out float level);
        int SetMute([MarshalAs(UnmanagedType.Bool)]bool mute,ref Guid context);int GetMute([MarshalAs(UnmanagedType.Bool)]out bool mute);
    }
    static readonly Guid ownContext=new("A408B973-D902-46CA-9F0B-6CD970C0AC18");
    static IEndpointVolume? endpoint;static bool originalMute,active;static float originalLevel;static System.Threading.Timer? timer;
    static IEndpointVolume Open(){var devices=(IDeviceEnumerator)new DeviceEnumerator();Marshal.ThrowExceptionForHR(devices.GetDefaultAudioEndpoint(0,1,out var device));var id=typeof(IEndpointVolume).GUID;Marshal.ThrowExceptionForHR(device.Activate(ref id,23,IntPtr.Zero,out var volume));return (IEndpointVolume)volume;}
    public static object Begin()
    {
        lock(typeof(AudioDucker)){
            if(!active){endpoint=Open();endpoint.GetMute(out originalMute);endpoint.GetMasterVolumeLevelScalar(out originalLevel);var context=ownContext;Marshal.ThrowExceptionForHR(endpoint.SetMute(true,ref context));active=true;}
            timer?.Dispose();timer=new System.Threading.Timer(_=>End(),null,25000,Timeout.Infinite);
            return new{active=true,wasMuted=originalMute};
        }
    }
    public static object Heartbeat(){lock(typeof(AudioDucker)){if(active)timer?.Change(25000,Timeout.Infinite);return new{active};}}
    public static object End()
    {
        lock(typeof(AudioDucker)){
            timer?.Dispose();timer=null;
            if(active&&endpoint!=null){try{endpoint.GetMute(out bool muted);endpoint.GetMasterVolumeLevelScalar(out float currentLevel);if(muted&&Math.Abs(currentLevel-originalLevel)<.001){var context=ownContext;endpoint.SetMute(originalMute,ref context);}}catch{}finally{active=false;Marshal.ReleaseComObject(endpoint);endpoint=null;}}
            return new{active=false};
        }
    }
    public static object State(){var volume=Open();volume.GetMute(out bool muted);volume.GetMasterVolumeLevelScalar(out float level);Marshal.ReleaseComObject(volume);return new{muted,level,ducking=active};}
    public static object Unmute(){var volume=Open();var context=ownContext;Marshal.ThrowExceptionForHR(volume.SetMute(false,ref context));Marshal.ReleaseComObject(volume);return State();}
}
