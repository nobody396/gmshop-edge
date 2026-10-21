import type { Column, Table } from "@tanstack/react-table";
import {
	AlignJustify,
	Check,
	RefreshCw,
	SlidersHorizontal,
	X,
} from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { ProButton, type ProButtonSize } from "../base/button";
import { Input } from "../base/fields/input";
import { Select } from "../base/fields/select";
import type { ProTableSearch, TableSize } from "./types";

const TABLE_SIZE_OPTIONS = [
	{
		value: "default",
		get label() {
			return m.pro_table_density_comfortable();
		},
	},
	{
		value: "middle",
		get label() {
			return m.pro_table_density_medium();
		},
	},
	{
		value: "compact",
		get label() {
			return m.pro_table_density_compact();
		},
	},
] as const;

export function ProTableToolbar<TData>({
	table,
	search,
	filters,
	actions,
	size,
	columnSettings,
	density = true,
	refresh,
	disabled = false,
	tableSize = "default",
	onTableSizeChange,
}: {
	table: Table<TData>;
	search?: ProTableSearch;
	filters?: ReactNode;
	actions?: ReactNode;
	size?: ProButtonSize;
	columnSettings?: ReactNode;
	density?: boolean;
	refresh?: () => void;
	disabled?: boolean;
	tableSize?: TableSize;
	onTableSizeChange?: (size: TableSize) => void;
}) {
	const toolbarButtonSize = size ?? "icon";
	const resetButtonSize = size ?? "sm";
	const searchColumns = getTableSearchColumns(table, search);
	const filterControls = table.getAllColumns().flatMap((column) => {
		const filter = column.columnDef.meta?.filter;
		if (!filter) return [];
		const rawFilterValue = column.getFilterValue();
		const values = Array.isArray(rawFilterValue)
			? rawFilterValue.filter(
					(item): item is string => typeof item === "string",
				)
			: [];
		const filterValue = getFilterValue(rawFilterValue, values);

		return [
			<Select
				key={`filter-${column.id}`}
				allowClear
				className="h-8 w-full md:w-[180px]"
				multiple={filter.multiple}
				onChange={(value) => column.setFilterValue(value)}
				options={filter.options.map((option) => {
					const count = column.getFacetedUniqueValues().get(option.value);
					return {
						...option,
						label:
							count === undefined ? (
								option.label
							) : (
								<span className="flex min-w-0 flex-1 items-center justify-between gap-3">
									<span className="truncate">{option.label}</span>
									<span className="shrink-0 font-mono text-xs text-muted-foreground">
										{count}
									</span>
								</span>
							),
					};
				})}
				placeholder={filter.placeholder ?? column.id}
				searchable={filter.searchable ?? filter.options.length > 8}
				value={filterValue}
			/>,
		];
	});

	return (
		<div className="flex w-full flex-col gap-2 md:flex-row md:items-center md:justify-between">
			<div className="flex min-w-0 flex-1 flex-wrap items-start gap-2 md:items-center">
				{searchColumns.map((searchColumn) => {
					const rawSearchValue = searchColumn.getFilterValue();
					const searchValue =
						typeof rawSearchValue === "string" ? rawSearchValue : "";
					const columnSearchPlaceholder =
						typeof searchColumn.columnDef.meta?.search === "object"
							? searchColumn.columnDef.meta.search.placeholder
							: undefined;
					return (
						<ProTableSearchInput
							disabled={disabled}
							key={`search-${searchColumn.id}`}
							onValueChange={(value) =>
								searchColumn.setFilterValue(value || undefined)
							}
							placeholder={getSearchPlaceholder(
								searchColumn,
								search,
								columnSearchPlaceholder,
							)}
							value={searchValue}
						/>
					);
				})}
				{filterControls}
				{filters}
				{table.getState().columnFilters.length > 0 ? (
					<ProButton
						disabled={disabled}
						onClick={() => table.resetColumnFilters()}
						size={resetButtonSize}
						variant="ghost"
					>
						<X />
						{m.pro_action_reset()}
					</ProButton>
				) : null}
			</div>
			<div className="flex flex-wrap items-center justify-end gap-2 md:ml-auto md:shrink-0">
				{actions}
				{refresh ? (
					<ProButton
						disabled={disabled}
						onClick={refresh}
						size={toolbarButtonSize}
						tooltip={m.pro_action_refresh()}
						variant="ghost"
					>
						<RefreshCw />
					</ProButton>
				) : null}
				{density && onTableSizeChange ? (
					<DropdownMenuPrimitive.Root>
						<DropdownMenuPrimitive.Trigger asChild>
							<ProButton
								disabled={disabled}
								size={toolbarButtonSize}
								tooltip={m.pro_action_density()}
								variant="ghost"
							>
								<AlignJustify />
							</ProButton>
						</DropdownMenuPrimitive.Trigger>
						<DropdownMenuPrimitive.Portal>
							<DropdownMenuPrimitive.Content
								align="end"
								className="z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
								sideOffset={4}
							>
								{TABLE_SIZE_OPTIONS.map((option) => (
									<DropdownMenuPrimitive.Item
										className="relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
										key={option.value}
										onSelect={() => onTableSizeChange(option.value)}
									>
										<Check
											className={cn(
												"size-4",
												tableSize === option.value
													? "opacity-100"
													: "opacity-0",
											)}
										/>
										<span>{option.label}</span>
									</DropdownMenuPrimitive.Item>
								))}
							</DropdownMenuPrimitive.Content>
						</DropdownMenuPrimitive.Portal>
					</DropdownMenuPrimitive.Root>
				) : null}
				{columnSettings ? (
					<DropdownMenuPrimitive.Root>
						<DropdownMenuPrimitive.Trigger asChild>
							<ProButton
								disabled={disabled}
								size={toolbarButtonSize}
								tooltip={m.pro_action_columns()}
								variant="ghost"
							>
								<SlidersHorizontal />
							</ProButton>
						</DropdownMenuPrimitive.Trigger>
						<DropdownMenuPrimitive.Portal>
							<DropdownMenuPrimitive.Content
								align="end"
								className="z-50 max-h-(--radix-dropdown-menu-content-available-height) w-[240px] min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-0 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
								sideOffset={4}
							>
								{columnSettings}
							</DropdownMenuPrimitive.Content>
						</DropdownMenuPrimitive.Portal>
					</DropdownMenuPrimitive.Root>
				) : null}
			</div>
		</div>
	);
}

function ProTableSearchInput({
	disabled,
	onValueChange,
	placeholder,
	value,
}: {
	disabled: boolean;
	onValueChange: (value: string) => void;
	placeholder?: string;
	value: string;
}) {
	const [draft, setDraft] = useState(value);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => setDraft(value), [value]);
	useEffect(() => {
		if (draft === value || draft === "") return;
		timeoutRef.current = setTimeout(() => onValueChange(draft), 300);
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, [draft, onValueChange, value]);

	const commit = (nextValue: string) => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);
		onValueChange(nextValue);
	};

	return (
		<Input
			allowClear={false}
			className="h-8 w-full md:w-[200px]"
			disabled={disabled}
			onChange={(event) => {
				const nextValue = event.target.value;
				setDraft(nextValue);
				if (nextValue === "") commit("");
			}}
			onKeyDown={(event) => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				commit(draft);
			}}
			placeholder={placeholder}
			value={draft}
		/>
	);
}

function getSearchPlaceholder<TData>(
	searchColumn: Column<TData, unknown> | undefined,
	search: ProTableSearch | undefined,
	columnSearchPlaceholder: string | undefined,
) {
	if (!searchColumn) return undefined;
	const fallback =
		columnSearchPlaceholder ??
		m.pro_table_searchColumn({ column: searchColumn.id });
	return typeof search === "object"
		? (search.placeholder ?? fallback)
		: fallback;
}

function getFilterValue(rawFilterValue: unknown, values: string[]) {
	if (typeof rawFilterValue === "string") return rawFilterValue;
	return Array.isArray(rawFilterValue) &&
		values.length === rawFilterValue.length
		? values
		: undefined;
}

function getTableSearchColumns<TData>(
	table: Table<TData>,
	search: ProTableSearch | undefined,
) {
	if (typeof search === "string") {
		const column = table.getColumn(search);
		return column ? [column] : [];
	}
	if (typeof search === "object") {
		const column = table.getColumn(search.columnId);
		return column ? [column] : [];
	}
	if (search === false) return [];
	return table
		.getAllLeafColumns()
		.filter(
			(column) =>
				column.columnDef.meta?.search !== undefined &&
				column.columnDef.meta.search !== false,
		);
}
