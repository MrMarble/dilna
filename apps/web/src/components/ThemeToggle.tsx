import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";

export function ThemeToggle({ className }: { className?: string }) {
	const { theme, toggleTheme } = useTheme();
	const label =
		theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			onClick={toggleTheme}
			title={label}
			aria-label={label}
			className={className}
		>
			{theme === "dark" ? <Sun /> : <Moon />}
		</Button>
	);
}
