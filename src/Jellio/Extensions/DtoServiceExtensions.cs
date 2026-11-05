using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Dto;
using Microsoft.Extensions.Logging;

namespace Jellio.Extensions;

public static class DtoServiceExtensions
{
    private static readonly MethodInfo? InterfaceBatchMethod = typeof(IDtoService)
        .GetMethods()
        .FirstOrDefault(m => m.Name == nameof(IDtoService.GetBaseItemDtos));

    public static IReadOnlyList<BaseItemDto> GetBaseItemDtosCompat(
        this IDtoService dtoService,
        IReadOnlyList<BaseItem> items,
        DtoOptions options,
        User? user = null,
        ILogger? logger = null)
    {
        ArgumentNullException.ThrowIfNull(dtoService);
        ArgumentNullException.ThrowIfNull(items);
        ArgumentNullException.ThrowIfNull(options);

        if (items.Count == 0)
        {
            return Array.Empty<BaseItemDto>();
        }

        var method = InterfaceBatchMethod
            ?? dtoService.GetType().GetMethods().FirstOrDefault(m => m.Name == nameof(IDtoService.GetBaseItemDtos) && m.GetParameters().Length >= 2);

        if (method is not null)
        {
            try
            {
                var parameters = method.GetParameters();
                var args = new object?[parameters.Length];
                if (parameters.Length > 0) args[0] = items;
                if (parameters.Length > 1) args[1] = options;
                if (parameters.Length > 2) args[2] = user;
                if (parameters.Length > 3) args[3] = null;
                if (parameters.Length > 4) args[4] = false;
                for (var i = 5; i < parameters.Length; i++)
                {
                    args[i] = parameters[i].HasDefaultValue
                        ? parameters[i].DefaultValue
                        : (parameters[i].ParameterType.IsValueType ? Activator.CreateInstance(parameters[i].ParameterType) : null);
                }

                if (method.Invoke(dtoService, args) is IReadOnlyList<BaseItemDto> batch)
                {
                    return batch;
                }
            }
            catch (Exception ex)
            {
                logger?.LogDebug(ex, "Jellio: IDtoService.GetBaseItemDtos invocation failed, falling back to per-item conversion");
            }
        }

        var result = new List<BaseItemDto>(items.Count);
        foreach (var item in items)
        {
            result.Add(dtoService.GetBaseItemDto(item, options, user));
        }

        return result;
    }
}
