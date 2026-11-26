# This block runs on the Hyper-V host, including when the dashboard uses WinRM.
$screenOp = {
    param($op)
    $ErrorActionPreference='Stop'
    function Send-DeviceInput($device,[string]$method,[hashtable]$arguments) {
        $result=Invoke-CimMethod -InputObject $device -MethodName $method -Arguments $arguments
        if($result.ReturnValue -ne 0){throw 'Hyper-V rejected console input.'}
    }
    function Release-Inputs {
        foreach($key in @($global:hvScreen.keys.Keys)){
            Send-DeviceInput $global:hvScreen.keyboard 'ReleaseKey' @{KeyCode=[uint32]$key}
            $global:hvScreen.keys.Remove($key)
        }
        foreach($button in @($global:hvScreen.buttons.Keys)){
            Send-DeviceInput $global:hvScreen.mouse 'SetButtonState' @{ButtonIndex=[uint32]$button;IsDown=$false}
            $global:hvScreen.buttons.Remove($button)
        }
    }
    $ns='root/virtualization/v2'
    switch($op.command){
        'open' {
            $vm=Get-VM -Id ([guid]$op.id) -ErrorAction Stop
            if($vm.State -ne 'Running' -or (Get-VMSecurity -VM $vm).Shielded){throw 'This guest display is unavailable.'}
            $filter="SystemName='$($vm.Id)'"
            $computer=Get-CimInstance -Namespace $ns -ClassName Msvm_ComputerSystem -Filter "Name='$($vm.Id)'"
            $settings=Get-CimAssociatedInstance -InputObject $computer -Association Msvm_SettingsDefineState -ResultClassName Msvm_VirtualSystemSettingData
            $keyboard=Get-CimInstance -Namespace $ns -ClassName Msvm_Keyboard -Filter $filter
            $mouse=Get-CimInstance -Namespace $ns -ClassName Msvm_SyntheticMouse -Filter $filter
            if(!$settings -or !$keyboard -or !$mouse){throw 'Console devices unavailable.'}
            Add-Type -AssemblyName System.Drawing
            $global:hvScreen=@{settings=$settings;keyboard=$keyboard;mouse=$mouse;filter=$filter;computer=$computer;checked=[datetime]::UtcNow;
                service=(Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemManagementService);
                keys=@{};buttons=@{};hash='';width=0;height=0;sha=[Security.Cryptography.SHA256]::Create()}
            return 'ready'
        }
        'read' {
            $state=$global:hvScreen
            if(([datetime]::UtcNow-$state.checked).TotalSeconds -ge 3){
                if((Get-CimInstance -InputObject $state.computer).EnabledState -ne 2){throw 'The VM is no longer running.'}
                $state.checked=[datetime]::UtcNow
            }
            $head=Get-CimInstance -Namespace $ns -ClassName Msvm_VideoHead -Filter $state.filter | Select-Object -First 1
            $state.width=[int]$head.CurrentHorizontalResolution
            $state.height=[int]$head.CurrentVerticalResolution
            if($state.width -lt 2 -or $state.height -lt 2){return ''}
            $scale=[math]::Min(1.0,[math]::Min(1280.0/$state.width,900.0/$state.height))
            # An even width gives RGB565 rows the same stride as a GDI bitmap.
            $w=[int][math]::Max(2,2*[math]::Floor($state.width*$scale/2))
            $h=[int][math]::Max(1,[math]::Round($state.height*$scale))
            $shot=Invoke-CimMethod -InputObject $state.service -MethodName GetVirtualSystemThumbnailImage -Arguments @{
                TargetSystem=$state.settings;WidthPixels=[uint16]$w;HeightPixels=[uint16]$h
            }
            if($shot.ReturnValue -ne 0){throw 'Hyper-V could not capture the display.'}
            [byte[]]$pixels=$shot.ImageData
            $length=$w*$h*2
            $offset=$pixels.Length-$length
            if($offset -notin @(0,4)){throw 'Unexpected Hyper-V frame size.'}
            $hash="$w/$h/"+[Convert]::ToBase64String($state.sha.ComputeHash($pixels))
            if($hash -ceq $state.hash){return ''}
            $format=[Drawing.Imaging.PixelFormat]::Format16bppRgb565
            $bitmap=[Drawing.Bitmap]::new($w,$h,$format)
            $jpeg=[IO.MemoryStream]::new()
            try {
                $bits=$bitmap.LockBits([Drawing.Rectangle]::new(0,0,$w,$h),'WriteOnly',$format)
                try {[Runtime.InteropServices.Marshal]::Copy($pixels,$offset,$bits.Scan0,$length)}
                finally {$bitmap.UnlockBits($bits)}
                $bitmap.Save($jpeg,[Drawing.Imaging.ImageFormat]::Jpeg)
                $state.hash=$hash
                return [Convert]::ToBase64String($jpeg.GetBuffer(),0,[int]$jpeg.Length)
            } finally {$jpeg.Dispose();$bitmap.Dispose()}
        }
        'input' {
            $state=$global:hvScreen
            foreach($event in $op.events){
                switch($event.type){
                    'key' {
                        $key=[uint32]$event.key
                        if($event.down){
                            $state.keys[$key]=$true
                            Send-DeviceInput $state.keyboard 'PressKey' @{KeyCode=$key}
                        } else {
                            Send-DeviceInput $state.keyboard 'ReleaseKey' @{KeyCode=$key}
                            $state.keys.Remove($key)
                        }
                    }
                    'move' {
                        if($state.width -gt 0 -and $state.height -gt 0){
                            Send-DeviceInput $state.mouse 'SetAbsolutePosition' @{
                                HorizontalPosition=[int]([double]$event.x*($state.width-1)/65535)
                                VerticalPosition=[int]([double]$event.y*($state.height-1)/65535)
                            }
                        }
                    }
                    'button' {
                        $button=[uint32]$event.button
                        if($event.down){$state.buttons[$button]=$true}
                        Send-DeviceInput $state.mouse 'SetButtonState' @{ButtonIndex=$button;IsDown=[bool]$event.down}
                        if(!$event.down){$state.buttons.Remove($button)}
                    }
                    'wheel' {Send-DeviceInput $state.mouse 'SetScrollPosition' @{ScrollPositionDelta=[int]$event.delta}}
                    'cad' {Send-DeviceInput $state.keyboard 'TypeCtrlAltDel' @{}}
                    'release' {Release-Inputs}
                    default {throw 'Unknown screen input.'}
                }
            }
            return ''
        }
        'close' {
            if($global:hvScreen){
                try {Release-Inputs} finally {$global:hvScreen.sha.Dispose();$global:hvScreen=$null}
            }
            return ''
        }
        default {throw 'Unknown display operation.'}
    }
}
