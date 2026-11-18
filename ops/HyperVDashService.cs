using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Xml;
using Microsoft.Win32.SafeHandles;

// .NET Framework 4.x Service Control Manager adapter. Node and its workers
// share a Windows job, so an SCM stop or wrapper crash closes their handles.
internal sealed class DashboardService : ServiceBase {
    private Process child;
    private SafeFileHandle job;
    private volatile bool stopping;
    private string logPath;
    private readonly string configFile;
    private readonly object logLock = new object();

    internal DashboardService(string file) {
        configFile = file;
        ServiceName = "HyperVDash";
        CanStop = true;
        CanShutdown = true;
        AutoLog = false;
    }
    private void Log(string message) {
        lock (logLock) {
            if (logPath == null) return;
            var info = new FileInfo(logPath);
            if (info.Exists && info.Length > 1024 * 1024) {
                File.Copy(logPath, logPath + ".1", true);
                File.WriteAllText(logPath, "");
            }
            File.AppendAllText(logPath, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine);
        }
    }
    protected override void OnStart(string[] args) {
        var doc = new XmlDocument { XmlResolver = null };
        using (var reader = XmlReader.Create(configFile, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit })) doc.Load(reader);
        var cfg = doc.DocumentElement;
        var app = cfg.GetAttribute("app");
        var data = cfg.GetAttribute("data");
        logPath = Path.Combine(cfg.GetAttribute("logs"), "service.log");
        var start = new ProcessStartInfo {
            FileName = cfg.GetAttribute("node"),
            Arguments = "server.mjs",
            WorkingDirectory = app,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true
        };
        start.EnvironmentVariables["HVDASH_DATA"] = data;
        start.EnvironmentVariables["HVDASH_BIND"] = cfg.GetAttribute("bind");
        start.EnvironmentVariables["HVDASH_PORT"] = cfg.GetAttribute("port");
        start.EnvironmentVariables["HVDASH_ORIGIN"] = cfg.GetAttribute("origin");
        start.EnvironmentVariables["HVDASH_WINDOWS_SERVICE"] = "1";
        start.EnvironmentVariables.Remove("HVDASH_ACCOUNT_PASSWORD");
        start.EnvironmentVariables.Remove("HVDASH_FAKE");
        stopping = false;
        Log("Starting management API.");
        job = Native.CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid) throw new Win32Exception();
        try {
            var limits = new Native.ExtendedLimits();
            limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!Native.SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new Win32Exception();
            child = Process.Start(start);
            if (!Native.AssignProcessToJobObject(job, child.Handle)) throw new Win32Exception();
            child.Exited += delegate {
                if (!stopping) {
                    try { Log("API exited unexpectedly. SCM recovery will restart the service."); }
                    finally { Environment.Exit(1); }
                }
            };
            child.EnableRaisingEvents = true;
        } catch {
            stopping = true;
            if (child != null && !child.HasExited) child.Kill();
            job.Dispose();
            throw;
        }
    }
    protected override void OnStop() {
        stopping = true;
        try {
            if (child != null && !child.HasExited) {
                try { child.StandardInput.WriteLine("shutdown"); child.StandardInput.Close(); } catch (IOException) { }
                child.WaitForExit(8000);
            }
        } finally {
            if (job != null) job.Dispose();
            if (child != null) child.Dispose();
            Log("Management API stopped.");
        }
    }
    protected override void OnShutdown() { OnStop(); }
    static int Main(string[] args) {
        if (args.Length != 1 || !Path.IsPathRooted(args[0])) return 2;
        ServiceBase.Run(new DashboardService(args[0]));
        return 0;
    }
    private static class Native {
        [StructLayout(LayoutKind.Sequential)]
        internal struct BasicLimits {
            internal long userTime, jobTime;
            internal uint flags;
            internal UIntPtr minWorking, maxWorking;
            internal uint activeProcesses;
            internal UIntPtr affinity;
            internal uint priority, scheduling;
        }
        [StructLayout(LayoutKind.Sequential)]
        internal struct ExtendedLimits {
            internal BasicLimits basic;
            internal ulong reads, writes, other, readBytes, writeBytes, otherBytes;
            internal UIntPtr processMemory, jobMemory, peakProcess, peakJob;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern SafeFileHandle CreateJobObject(IntPtr security, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimits info, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    }
}
