import * as DialogPrimitive from '@radix-ui/react-dialog'
import {X} from 'lucide-react'
export const Dialog=DialogPrimitive.Root
export const DialogTitle=DialogPrimitive.Title
export const DialogDescription=DialogPrimitive.Description
export function DialogContent({children}){return <DialogPrimitive.Portal><DialogPrimitive.Overlay className="dialog-overlay"/><DialogPrimitive.Content className="dialog-content">{children}<DialogPrimitive.Close aria-label="关闭" className="dialog-cross"><X size={19}/></DialogPrimitive.Close></DialogPrimitive.Content></DialogPrimitive.Portal>}
