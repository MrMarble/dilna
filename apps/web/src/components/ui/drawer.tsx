import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { cn } from "@/lib/utils";

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
	return <DrawerPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
	return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
	return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
	return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerOverlay({
	className,
	...props
}: DrawerPrimitive.Backdrop.Props) {
	return (
		<DrawerPrimitive.Backdrop
			data-slot="drawer-overlay"
			className={cn(
				"fixed inset-0 isolate z-50 min-h-dvh bg-black/20 opacity-[calc(1-var(--drawer-swipe-progress,0))] duration-300 supports-backdrop-filter:backdrop-blur-xs data-swiping:duration-0 data-ending-style:opacity-0 data-starting-style:opacity-0",
				className,
			)}
			{...props}
		/>
	);
}

// Required by Base UI's Drawer.Popup so swipe-to-dismiss gestures and touch
// scroll locking are wired up (rendering Popup without it degrades silently
// to a non-swipeable sheet, logging a dev warning) — see
// https://base-ui.com/react/components/drawer.
function DrawerViewport({
	className,
	...props
}: DrawerPrimitive.Viewport.Props) {
	return (
		<DrawerPrimitive.Viewport
			data-slot="drawer-viewport"
			className={cn("fixed inset-0 z-50 flex items-end justify-center", className)}
			{...props}
		/>
	);
}

function DrawerContent({
	className,
	children,
	...props
}: DrawerPrimitive.Popup.Props) {
	return (
		<DrawerPortal>
			<DrawerOverlay />
			<DrawerViewport>
				<DrawerPrimitive.Popup
					data-slot="drawer-content"
					className={cn(
						"flex max-h-[80vh] w-full flex-col overflow-hidden rounded-t-xl bg-popover pb-[env(safe-area-inset-bottom)] text-popover-foreground ring-1 ring-foreground/10 outline-none [transform:translateY(var(--drawer-swipe-movement-y,0px))] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-swiping:duration-0 data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)]",
						"transition-transform",
						className,
					)}
					{...props}
				>
					<div
						aria-hidden="true"
						className="mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30"
					/>
					{children}
				</DrawerPrimitive.Popup>
			</DrawerViewport>
		</DrawerPortal>
	);
}

export {
	Drawer,
	DrawerClose,
	DrawerContent,
	DrawerOverlay,
	DrawerPortal,
	DrawerTrigger,
	DrawerViewport,
};
